/**
 * The claim each mutation run's supervisor holds on the run's folder, and the
 * one checkout-wide lock runs share when bringing kept files back.
 *
 * The claim mechanics live in #scripts/stale-claim.ts, which the stripe-mock
 * install shares. The supervisor takes its run's claim before the run's first
 * record write and keeps it fresh until the snapshot is gone, so a clear-up
 * can tell a run somebody still owns (fresh claim) from one whose supervisor
 * has walked away (stale or missing claim) — without ever asking a process id
 * that may since have been handed to somebody else.
 */

import { type LockBody, withFileLock } from "#scripts/lock-file.ts";
import {
  ageClaimToStale,
  claimIsFresh,
  keepClaimFresh,
  withClaim,
  withClaimGuard,
} from "#scripts/stale-claim.ts";
import {
  copyBackLockPath,
  type MutationRunRecord,
  runClaimPath,
} from "./isolation-state.ts";

/**
 * A claim untouched for this long belongs to a supervisor that has walked
 * away — killed, or on a machine that stopped — and its folder may be
 * cleared. Generous next to the touch below, so a briefly starved supervisor
 * does not lose its run.
 */
export const RUN_CLAIM_STALE_MS = 30_000;

const RUN_CLAIM_SETTINGS = {
  staleMs: RUN_CLAIM_STALE_MS,
  touchMs: 1_000,
};

/** Hold this run's claim while the whole run happens. A run id is brand new,
 * so its claim is always free to take. */
export const withRunClaim = <Result>(
  record: Pick<MutationRunRecord, "id" | "root">,
  body: LockBody<Result>,
): Promise<Result> =>
  withClaim(
    runClaimPath(record),
    {
      ...RUN_CLAIM_SETTINGS,
      name: `the claim on isolated mutation run ${record.id}`,
      retryMs: 0,
      timeoutMs: 0,
    },
    body,
  );

/** Is this run's folder still somebody's? Only a run's own supervisor and its
 * child write and touch the claim, so a fresh one is always the run's. */
export const runClaimIsFresh = (
  record: Pick<MutationRunRecord, "root">,
): Promise<boolean> => claimIsFresh(runClaimPath(record), RUN_CLAIM_STALE_MS);

/**
 * Hold the run-claim takers' guard while `body` runs, so judging the run and
 * acting on the judgement cannot interleave with its supervisor mid-take.
 */
export const withRunClaimGuard = <Result>(
  record: Pick<MutationRunRecord, "root">,
  body: LockBody<Result>,
): Promise<Result> => withClaimGuard(runClaimPath(record), body);

/** The child's half of the claim: keep it fresh while the child works, so a
 * supervisor killed without cleaning up cannot cost a live child its copy. */
export const keepRunClaimFresh = (
  record: Pick<MutationRunRecord, "root">,
): ReturnType<typeof keepClaimFresh> =>
  keepClaimFresh(runClaimPath(record), RUN_CLAIM_SETTINGS);

/** Age the run's claim so it reads as walked away — for a child whose
 * supervisor died and so can never release it. */
export const ageRunClaimToStale = (
  record: Pick<MutationRunRecord, "root">,
  ownedBy: string,
): Promise<void> => ageClaimToStale(runClaimPath(record), ownedBy);

/**
 * Hold the checkout's copy-back lock. Every run brings its kept files back
 * through this one lock, so two runs finishing together cannot both read the
 * checkout, agree it is unchanged, and then write over each other.
 */
export const withCopyBackLock = <Result>(
  root: string,
  run: LockBody<Result>,
): Promise<Result> => withFileLock(copyBackLockPath(root), run);

/** Recheck whether copy-back is still wanted after waiting for its lock. */
export const withCopyBackLockWhen = <Result>(
  root: string,
  shouldRun: () => boolean,
  skippedResult: Result,
  run: LockBody<Result>,
): Promise<Result> =>
  withCopyBackLock(root, () =>
    shouldRun() ? run() : Promise.resolve(skippedResult),
  );
