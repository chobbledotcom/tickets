/**
 * The update write-stop. A deploy sets UPDATE_IN_PROGRESS on a site, and the
 * app refuses every write while it is set. The new build's data migration
 * then sees a still database. This module owns the contract that the deploy
 * and the read-only page share. It holds the variable name, the page marker,
 * the wait, and the guard that wraps one deploy.
 *
 * A failure after the flag is set leaves the flag set and rethrows. A site
 * stuck read-only is safer than a half-migrated one. The operator lifts the
 * flag by hand in the hosting dashboard, or re-runs the same update, whose
 * successful finish lifts it.
 */

import { delay } from "#shared/now.ts";

/** The hosting-provider secret that puts a site into update mode. */
export const UPDATE_IN_PROGRESS_VAR = "UPDATE_IN_PROGRESS";

/** The value a deploy writes to engage update mode. Presence, not content,
 * decides. */
export const UPDATE_FLAG_VALUE = "1";

/** The value that lifts update mode where the provider has no delete. */
export const UPDATE_FLAG_LIFTED_VALUE = "";

export type UpdatePageState = "unsupported" | "supported" | "active";

const MARKER_NAME = 'name="update-in-progress"';

/** The head marker the read-only page carries. "supported" says this build
 * understands UPDATE_IN_PROGRESS. "active" says the update page shows right
 * now. The deploy helpers match these values, so both sides of the wait
 * share one definition here. */
export const updatePageMeta = (state: "supported" | "active"): string =>
  `<meta ${MARKER_NAME} content="${state}" />`;

/** Read the update-mode state off a /read-only page body. */
export const updatePageState = (html: string): UpdatePageState => {
  if (html.includes(updatePageMeta("active"))) return "active";
  return html.includes(MARKER_NAME) ? "supported" : "unsupported";
};

export const UPDATE_WAIT_INTERVAL_MS = 5_000;
export const UPDATE_WAIT_TIMEOUT_MS = 180_000;

const waitTimedOut = (ms: number, lastError: string | null): string =>
  `The site did not show its update page within ${Math.round(ms / 1000)} seconds. ` +
  "UPDATE_IN_PROGRESS is still set, so the site still refuses every write. " +
  "Fix the cause, then re-run the same update, or remove UPDATE_IN_PROGRESS " +
  "from the script's environment in the hosting dashboard." +
  (lastError === null ? "" : ` The last page check failed: ${lastError}`);

/** The clock, wait, and log that every update helper accepts, so tests step
 * time instead of sleeping. */
export type UpdateIoOptions = {
  log?: ((message: string) => void) | undefined;
  /** Steps a fake clock in tests. The real wait delays. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
};

/** The page fetch the wait polls. A failed fetch throws. The wait treats it
 * as not-ready and retries until the deadline. */
export type FetchUpdatePage = () => Promise<string>;

/** What the wait polls: the page fetch plus the shared clock and log. */
export type UpdatePollIo = UpdateIoOptions & {
  fetchPage: FetchUpdatePage;
};

export type UpdateWaitOptions = UpdatePollIo & {
  /** Return instead of time out when the running build predates update mode
   * and so never shows the update page. */
  skipWhenUnsupported?: boolean | undefined;
};

/** One poll: resolve the page state, or report the failure that stood in for
 * it. A failed fetch says nothing about the site's state. It counts as
 * not-ready, and the wait retries. */
const pollOnce = async (
  options: UpdateWaitOptions,
): Promise<{ lastError: string | null; state: UpdatePageState }> => {
  try {
    return {
      lastError: null,
      state: updatePageState(await options.fetchPage()),
    };
  } catch (error) {
    return {
      lastError: error instanceof Error ? error.message : String(error),
      state: "unsupported",
    };
  }
};

/** Poll the site's read-only page until the update page shows. A failed
 * page fetch says nothing about the site's state, so the wait retries it
 * until the deadline. A run-out names the last failure. The wait throws when
 * it runs out, and the caller keeps the update flag set. */
export const waitForUpdatePage = async (
  options: UpdateWaitOptions,
): Promise<void> => {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + UPDATE_WAIT_TIMEOUT_MS;
  for (;;) {
    const { state, lastError } = await pollOnce(options);
    if (state === "active") return;
    // A fetch failure must not read as "the build predates update mode". The
    // skip therefore fires only on a real unsupported page.
    if (
      lastError === null &&
      options.skipWhenUnsupported &&
      state === "unsupported"
    ) {
      options.log?.(
        "The site's running build does not understand update mode yet, so the " +
          "wait cannot confirm it went read-only. The deploy continues.",
      );
      return;
    }
    if (now() >= deadline) {
      throw new Error(waitTimedOut(UPDATE_WAIT_TIMEOUT_MS, lastError));
    }
    await sleep(UPDATE_WAIT_INTERVAL_MS);
  }
};

/** The operations one deploy needs to guard itself. A failed operation
 * throws. */
export type UpdateGuardIo = UpdatePollIo & {
  setFlag: (value: string) => Promise<void>;
  clearFlag: () => Promise<void>;
};

/** The wait options an io already carries. `skipWhenUnsupported` returns
 * instead of timing out when the running build predates update mode. */
export const waitOptionsFrom = (
  io: UpdatePollIo,
  skipWhenUnsupported = false,
): UpdateWaitOptions => ({
  fetchPage: io.fetchPage,
  log: io.log,
  now: io.now,
  skipWhenUnsupported,
  sleep: io.sleep,
});

/** The deploy body the guard wraps. */
export type UpdateRun<T> = () => Promise<T>;

/** Put a site into update mode around `run` (the code deploy itself). The
 * first wait proves the running copy went read-only before the deploy
 * touches it. The second wait proves the new build is serving. The new
 * build's first served request ran the migrations. */
export const runUnderUpdateGuard = async <T>(
  io: UpdateGuardIo,
  run: UpdateRun<T>,
): Promise<T> => {
  await io.setFlag(UPDATE_FLAG_VALUE);
  await waitForUpdatePage(waitOptionsFrom(io, true));
  const result = await run();
  await waitForUpdatePage(waitOptionsFrom(io));
  await io.clearFlag();
  return result;
};
