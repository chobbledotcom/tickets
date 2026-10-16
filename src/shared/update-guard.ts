/**
 * The update write-stop. A deploy sets UPDATE_IN_PROGRESS on a site, and the
 * app refuses every write while it is set. The new build's data migration
 * then sees a still database. This module owns the contract that the deploy
 * and the read-only page share. It holds the variable name, the page marker,
 * the wait, and the guard that wraps one deploy.
 *
 * A failure after the flag is set leaves the flag set and rethrows. A site
 * stuck read-only is safer than a half-migrated one. The begin schedule is
 * the exception: before any update runs, a run-out reverts the flag and
 * raises the error.
 */

import { errorMessage } from "#shared/error-message.ts";
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

/** The begin schedule's segments. The flag's propagation to the serving
 * edge nodes lags the API write that set it. The begin wait checks the
 * site 10, 30, and 60 seconds in. A site that still serves its normal page
 * at the last mark reverts the flag and fails the deploy loudly. Fail safe
 * plus retry beats blocking. The checks are single hits with quiet gaps
 * between them. The gap lets the old app stop serving and the flag set.
 * Immediate repeated checking kept the old app online and raced the
 * propagation. */
export const UPDATE_BEGIN_FIRST_WAIT_MS = 10_000;
export const UPDATE_BEGIN_SECOND_WAIT_MS = 20_000;
export const UPDATE_BEGIN_THIRD_WAIT_MS = 30_000;

/** The longest one update-page fetch can take. A stalled connection must
 * end on its own, or the wait hangs forever: the failed-check abort fires
 * only after the fetch settles. */
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

const waitTimedOut = (ms: number, buildMismatch: string | null): string =>
  `The site did not show its update page within ${Math.round(ms / 1000)} seconds. ` +
  "UPDATE_IN_PROGRESS is still set, so the site still refuses every write. " +
  "Fix the cause, then re-run the same update, or remove UPDATE_IN_PROGRESS " +
  "from the script's environment in the hosting dashboard." +
  (buildMismatch === null ? "" : buildMismatch);

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

/** The page fetch the wait polls. The fetch answers a 2xx body or throws.
 * The caller's wrapper turns every other status into a throw. A throw ends
 * the wait immediately. The schedule is only for a 2xx page that does not
 * show the update message yet. */
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
};

/** One poll: the page state, the build the page names, and the failure
 * that stood in for the state. */
type UpdatePoll = {
  buildTag: string | null;
  lastError: string | null;
  state: UpdatePageState;
};

/** One poll: the page state, the build the page names, and the failure
 * that stood in for the state. A failed fetch says nothing about the
 * site's state, so the wait ends on it instead of guessing. */
const pollOnce = async (options: UpdateWaitOptions): Promise<UpdatePoll> => {
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

const UNSUPPORTED_SKIP_MESSAGE =
  "The site's running build does not understand update mode yet, so the " +
  "wait cannot confirm it went read-only. The deploy continues.";

/** Whether one check satisfied the wait: the update page shows, and it
 * names the expected build when the caller pinned one. */
const pollIsReady = (
  options: UpdateWaitOptions,
  poll: { buildTag: string | null; state: UpdatePageState },
): boolean =>
  poll.state === "active" &&
  (options.expectedBuildTag === undefined ||
    poll.buildTag === options.expectedBuildTag);

/** What one check found. "ready" ends the wait. "skip" ends it when the
 * caller asked to skip a build that predates update mode. "abort" ends it
 * now, because the check itself failed. "unchanged" keeps the wait going:
 * the schedule is only for a 2xx page that does not show the update
 * message yet. */
type CheckDecision =
  | { kind: "abort"; lastError: string }
  | { kind: "ready" }
  | { kind: "skip" }
  | { kind: "unchanged" };

const checkDecision = (
  options: UpdateWaitOptions,
  poll: UpdatePoll,
): CheckDecision => {
  if (pollIsReady(options, poll)) return { kind: "ready" };
  if (poll.lastError !== null) {
    return { kind: "abort", lastError: poll.lastError };
  }
  if (options.skipWhenUnsupported && poll.state === "unsupported") {
    return { kind: "skip" };
  }
  return { kind: "unchanged" };
};

/** The clock and sleep one wait runs on, taken from the caller's io with
 * the real defaults filled in. */
const waitClockFrom = (
  options: UpdateWaitOptions,
): { now: () => number; sleep: (ms: number) => Promise<void> } => ({
  now: options.now ?? Date.now,
  sleep: options.sleep ?? delay,
});

/** The plan one wait follows: the quiet gap before each check, and what
 * happens after a check that still finds the page unchanged. Keep waiting,
 * or end the wait with an error the loop raises. A failed check bypasses
 * the plan's schedule: the loop ends the wait at once through `failedCheck`. */
type UpdateWaitPlan = {
  gap: (checked: number) => number;
  /** One unchanged check's verdict: null keeps the wait going, and an
   * error ends it. */
  giveUp: (checked: number, poll: UpdatePoll) => Promise<Error | null>;
  /** One failed check's error. The wait ends the moment a check fails,
   * with the failure's detail in the message. */
  failedCheck: (lastError: string) => Promise<Error>;
};

/** The check loop both waits share: sleep the plan's gap, poll, and end
 * the wait on a ready page or a pre-update-mode build. A check that still
 * finds the page unchanged asks the plan. A non-null verdict ends the
 * loop, and the loop raises that error. A failed check ends the wait at
 * once through the plan's `failedCheck`. */
const loopChecks = async (
  options: UpdateWaitOptions,
  plan: UpdateWaitPlan,
): Promise<void> => {
  const { sleep } = waitClockFrom(options);
  let checked = 1;
  let runOut: Error | null = null;
  while (runOut === null) {
    // Zero is a real no-sleep path: the ordinary wait's first check must
    // fetch immediately, not on a timer.
    const gap = plan.gap(checked);
    if (gap > 0) await sleep(gap);
    const poll = await pollOnce(options);
    const decision = checkDecision(options, poll);
    if (decision.kind === "ready") return;
    if (decision.kind === "skip") {
      options.log?.(UNSUPPORTED_SKIP_MESSAGE);
      return;
    }
    if (decision.kind === "abort") {
      throw await plan.failedCheck(decision.lastError);
    }
    runOut = await plan.giveUp(checked, poll);
    checked += 1;
  }
  throw runOut;
};

/** Poll the site's read-only page until the update page shows. A failed
 * page fetch ends the wait immediately. A site the check cannot reach will
 * not answer better on a later check. The schedule is only for a 2xx page
 * that does not show the update message yet. With `expectedBuildTag`, the
 * page must also name that build. An active page from any other build
 * keeps the wait polling. The wait throws when it runs out, and the
 * caller keeps the update flag set. */
export const waitForUpdatePage = async (
  options: UpdateWaitOptions,
): Promise<void> => {
  const { now } = waitClockFrom(options);
  const deadline = now() + UPDATE_WAIT_TIMEOUT_MS;
  await loopChecks(options, {
    failedCheck: (lastError) =>
      Promise.resolve(updateCheckFailedError(lastError)),
    gap: (checked) => (checked === 1 ? 0 : UPDATE_WAIT_INTERVAL_MS),
    giveUp: async (_checked, poll) => {
      if (now() < deadline) return null;
      return new Error(
        waitTimedOut(
          UPDATE_WAIT_TIMEOUT_MS,
          buildMismatchNote(
            options.expectedBuildTag,
            poll.state,
            poll.buildTag,
          ),
        ),
      );
    },
  });
};

/** The error a failed page check raises after the deploy. The flag stays
 * set. A site the check cannot reach can still refuse writes. A re-run of
 * the same update lifts the flag on success. */
const updateCheckFailedError = (lastError: string): Error =>
  new Error(
    "The page check failed, so the wait cannot tell whether the deployed build serves. " +
      "UPDATE_IN_PROGRESS is still set, so the site still refuses every write. " +
      "Fix the cause, then re-run the same update, or remove UPDATE_IN_PROGRESS " +
      "from the script's environment in the hosting dashboard." +
      ` The last page check failed: ${lastError}`,
  );

/** The base a begin run-out names: the marks passed with the site still
 * serving its normal page. */
const beginTimedOutBase = (totalMs: number): string =>
  `The site did not show its update page within ${Math.round(totalMs / 1000)} seconds. `;

/** The error a begin wait ends with: a run-out at the last mark, or a
 * failed page check. The wait reverts the flag first through `revert`:
 * begin is pre-deploy, the revert happens before any update, so it cannot
 * hide a half-applied one. A failed revert is reported in the error's
 * detail and never replaces the wait's own failure. */
const beginAbortError = async (
  revert: () => Promise<void>,
  base: string,
  detail: string,
): Promise<Error> => {
  try {
    await revert();
  } catch (revertIssue) {
    return new Error(
      base +
        `Removing the flag failed: ${errorMessage(revertIssue)}, so UPDATE_IN_PROGRESS may still be set and the site may still refuse writes. Fix the removal failure, then re-run the same update, or remove UPDATE_IN_PROGRESS from the script's environment in the hosting dashboard.` +
        detail,
    );
  }
  return new Error(
    base +
      "The flag was removed, so the site accepts writes again. Re-run the deploy to retry." +
      detail,
  );
};

/** The detail a failed page check contributes to a wait's error. */
const pageCheckDetail = (lastError: string): string =>
  ` The last page check failed: ${lastError}`;

/** The scheduled begin wait: check the site 10, 30, and 60 seconds after
 * the flag was set. An update page at any mark ends the wait cleanly, and
 * a build that predates update mode skips the wait. A site that still
 * serves its normal page at the last mark reverts the flag through
 * `revert` and raises the error. A failed page check reverts the flag and
 * raises at once. The schedule is only for a page that answers but does
 * not show the update message. */
export const waitForBeginPropagation = async (
  options: UpdateWaitOptions,
  revert: () => Promise<void>,
): Promise<void> => {
  const segments = [
    UPDATE_BEGIN_FIRST_WAIT_MS,
    UPDATE_BEGIN_SECOND_WAIT_MS,
    UPDATE_BEGIN_THIRD_WAIT_MS,
  ];
  await loopChecks(options, {
    failedCheck: (lastError) =>
      beginAbortError(
        revert,
        "The page check failed, so the wait cannot tell whether the update page shows. ",
        pageCheckDetail(lastError),
      ),
    // giveUp ends the loop at segments.length, so the index stays in range.
    gap: (checked) => segments[checked - 1]!,
    giveUp: async (checked, _poll) => {
      // One line per check, naming the elapsed segment: a long propagation
      // window stays visible without noise.
      const elapsed = segments
        .slice(0, checked)
        .reduce((sum, segment) => sum + segment, 0);
      options.log?.(
        `The site still does not show its update page ${Math.round(elapsed / 1000)} seconds after the flag was set.`,
      );
      if (checked < segments.length) return null;
      return await beginAbortError(
        revert,
        beginTimedOutBase(segments.reduce((sum, segment) => sum + segment, 0)),
        "",
      );
    },
  });
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
 * begin schedule proves the running copy went read-only before the deploy
 * touches it. It reverts the flag when the marks pass with the site
 * unchanged. The second wait proves the build the deploy published is
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
  await waitForBeginPropagation(waitOptionsFrom(io, true), () =>
    io.clearFlag(),
  );
  const result = await run();
  await waitForUpdatePage(waitOptionsFrom(io, false, expectedBuildTag(result)));
  await io.clearFlag();
  return result;
};
