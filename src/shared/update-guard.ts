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

const BUILD_TAG_MARKER_NAME = 'name="update-build-tag"';

const BUILD_TAG_PATTERN = new RegExp(
  `<meta ${BUILD_TAG_MARKER_NAME} content="([^"]+)"`,
);

/** The head marker that names the running build by its release tag. The
 * page renders it from the build timestamp the bundle bakes in. The
 * post-deploy wait matches it against the build the deploy just published,
 * so an active page from the old build cannot pass the wait. */
export const updateBuildTagMeta = (buildTag: string): string =>
  `<meta ${BUILD_TAG_MARKER_NAME} content="${buildTag}" />`;

/** Read the running build's release tag off a /read-only page body. Return
 * null when the page carries no tag: a build from before this marker
 * existed. */
export const updatePageBuildTag = (html: string): string | null =>
  BUILD_TAG_PATTERN.exec(html)?.[1] ?? null;

export const UPDATE_WAIT_INTERVAL_MS = 5_000;
export const UPDATE_WAIT_TIMEOUT_MS = 180_000;

/** The begin wait's own deadline. Setting UPDATE_IN_PROGRESS writes the
 * script's environment on the Bunny API, and the serving edge nodes pick
 * that write up asynchronously. The first staging deploy after #2588 polled
 * for 180 seconds of pages that reported content="supported", and the wait
 * timed out before the flag reached them. The begin wait is pre-deploy, so
 * a longer window only delays. The end wait keeps the short deadline
 * because it verifies the build the deploy just published. */
export const UPDATE_BEGIN_WAIT_TIMEOUT_MS = 600_000;

/** The longest one update-page fetch can take. A stalled connection must end
 * before the wait's deadline, or the deadline can never fire. The aborted
 * fetch then counts as not-ready, and the wait retries. */
const UPDATE_PAGE_FETCH_TIMEOUT_MS = 30_000;

/** One eagerly read page response: the part of a fetch result the wait reads. */
type UpdatePageResult = { ok: boolean; status: number; text: string };

/** Fetch one update page through `fetchText`, bounded so a stalled request
 * ends before the wait's deadline. */
export const fetchBoundedUpdatePage = async (
  fetchText: (url: string, init: RequestInit) => Promise<UpdatePageResult>,
  url: string,
): Promise<UpdatePageResult> =>
  fetchText(url, {
    method: "GET",
    signal: AbortSignal.timeout(UPDATE_PAGE_FETCH_TIMEOUT_MS),
  });

const waitTimedOut = (
  ms: number,
  lastError: string | null,
  buildMismatch: string | null,
): string =>
  `The site did not show its update page within ${Math.round(ms / 1000)} seconds. ` +
  "UPDATE_IN_PROGRESS is still set, so the site still refuses every write. " +
  "Fix the cause, then re-run the same update, or remove UPDATE_IN_PROGRESS " +
  "from the script's environment in the hosting dashboard." +
  (buildMismatch === null ? "" : buildMismatch) +
  (lastError === null ? "" : ` The last page check failed: ${lastError}`);

/** Names the build that kept answering when the expected build never served,
 * so the operator can tell an unfinished publish from a wrong deploy. Return
 * null when the run-out does not name a mismatch. */
const buildMismatchNote = (
  expected: string | undefined,
  state: UpdatePageState,
  served: string | null,
): string | null => {
  if (expected === undefined || state !== "active") return null;
  return served === null
    ? ` The site answered from a build that reports no build tag, but the deploy expected ${expected}.`
    : ` The site answered from build ${served}, but the deploy expected ${expected}.`;
};

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
  /** The release tag of the build the deploy just published. The wait passes
   * only when the served update page names this build, so an active page
   * from the build the deploy replaces never passes. */
  expectedBuildTag?: string | undefined;
  /** The wait's deadline in milliseconds. Defaults to
   * UPDATE_WAIT_TIMEOUT_MS. The pre-deploy begin wait passes a longer
   * deadline because the flag's propagation to edge nodes lags the API
   * write that set it. */
  timeoutMs?: number | undefined;
};

/** One poll: resolve the page state, or report the failure that stood in for
 * it. A failed fetch says nothing about the site's state. It counts as
 * not-ready, and the wait retries. */
const pollOnce = async (
  options: UpdateWaitOptions,
): Promise<{
  buildTag: string | null;
  lastError: string | null;
  state: UpdatePageState;
}> => {
  try {
    const html = await options.fetchPage();
    return {
      buildTag: updatePageBuildTag(html),
      lastError: null,
      state: updatePageState(html),
    };
  } catch (error) {
    return {
      buildTag: null,
      lastError: error instanceof Error ? error.message : String(error),
      state: "unsupported",
    };
  }
};

/** A progress line once a minute while the page is missing, so a long
 * propagation window is visible in the deploy log. */
const progressLogger = (
  log: ((message: string) => void) | undefined,
  now: () => number,
  startedAt: number,
  timeoutMs: number,
): (() => void) => {
  let lastLoggedAt = startedAt;
  return () => {
    if (log === undefined || now() - lastLoggedAt < 60_000) return;
    lastLoggedAt = now();
    log(
      `The site still does not show its update page after ${Math.round(
        (now() - startedAt) / 1000,
      )} seconds of the ${Math.round(timeoutMs / 1000)}-second wait.`,
    );
  };
};

/** Whether one poll satisfied the wait: the update page shows, and it names
 * the expected build when the caller pinned one. */
const pollIsReady = (
  options: UpdateWaitOptions,
  poll: { buildTag: string | null; state: UpdatePageState },
): boolean =>
  poll.state === "active" &&
  (options.expectedBuildTag === undefined ||
    poll.buildTag === options.expectedBuildTag);

/** Poll the site's read-only page until the update page shows. A failed
 * page fetch says nothing about the site's state, so the wait retries it
 * until the deadline. With `expectedBuildTag`, the page must also name that
 * build: an active page from any other build keeps the wait polling. A
 * run-out names the last failure. The wait throws when it runs out, and the
 * caller keeps the update flag set. */
export const waitForUpdatePage = async (
  options: UpdateWaitOptions,
): Promise<void> => {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? UPDATE_WAIT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const logProgress = progressLogger(options.log, now, now(), timeoutMs);
  for (;;) {
    const poll = await pollOnce(options);
    if (pollIsReady(options, poll)) {
      return;
    }
    // A fetch failure must not read as "the build predates update mode". The
    // skip therefore fires only on a real unsupported page.
    if (
      poll.lastError === null &&
      options.skipWhenUnsupported &&
      poll.state === "unsupported"
    ) {
      options.log?.(
        "The site's running build does not understand update mode yet, so the " +
          "wait cannot confirm it went read-only. The deploy continues.",
      );
      return;
    }
    logProgress();
    if (now() >= deadline) {
      throw new Error(
        waitTimedOut(
          timeoutMs,
          poll.lastError,
          buildMismatchNote(
            options.expectedBuildTag,
            poll.state,
            poll.buildTag,
          ),
        ),
      );
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
 * instead of timing out when the running build predates update mode.
 * `expectedBuildTag` pins the post-deploy wait to the published build. */
export const waitOptionsFrom = (
  io: UpdatePollIo,
  skipWhenUnsupported = false,
  expectedBuildTag?: string,
): UpdateWaitOptions => ({
  expectedBuildTag,
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
 * touches it. The second wait proves the build the deploy published is
 * serving. The page must name that build: an active page the old build
 * still answers cannot lift the flag. The new build's first served request
 * ran the migrations. `expectedBuildTag` reads the published build's tag
 * off the deploy's result. */
export const runUnderUpdateGuard = async <T>(
  io: UpdateGuardIo,
  run: UpdateRun<T>,
  expectedBuildTag: (result: T) => string,
): Promise<T> => {
  await io.setFlag(UPDATE_FLAG_VALUE);
  // The begin wait is pre-deploy and runs on its own longer deadline: the
  // flag's propagation to edge nodes lags the write that set it.
  await waitForUpdatePage({
    ...waitOptionsFrom(io, true),
    timeoutMs: UPDATE_BEGIN_WAIT_TIMEOUT_MS,
  });
  const result = await run();
  await waitForUpdatePage(waitOptionsFrom(io, false, expectedBuildTag(result)));
  await io.clearFlag();
  return result;
};
