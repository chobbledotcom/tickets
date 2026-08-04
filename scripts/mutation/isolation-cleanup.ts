/**
 * Which mutation runs are still going, and deleting the ones that are not.
 *
 * The supervisor in isolation.ts uses this both to clear up before a new run
 * and to serve the explicit list/kill/clean commands. Whether a run is still
 * going is answered by its claim (isolation-lock.ts): a fresh claim means its
 * supervisor is alive and touching it, however long ago the record was
 * written and whatever became of the child's process id.
 */

import { chunk } from "#fp";
import { removeTree } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";
import { runClaimIsFresh, withRunClaimGuard } from "./isolation-lock.ts";
import {
  readRunRecord,
  recordInRunDirectory,
  runDirectoryNames,
} from "./isolation-records.ts";
import {
  isRunId,
  type MutationRunRecord,
  newRunRecord,
  recordPath,
} from "./isolation-state.ts";

/** Is this record's run started, and its folder still its supervisor's? */
export const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "running" &&
  record.pid !== undefined &&
  (await runClaimIsFresh(record));

type RemoveRunResult =
  | { record: MutationRunRecord; removed: true }
  | { error: unknown; record: MutationRunRecord; removed: false };

export const liveRunIdSet = async (
  records: MutationRunRecord[],
): Promise<Set<string>> => {
  const live = await Promise.all(
    records.map(async (record) =>
      (await processBelongsToRun(record)) ? record.id : null,
    ),
  );
  return new Set(live.filter((id): id is string => id !== null));
};

/** Delete one folder of a run, treating an already-missing folder as done. */
const removeRunPath = async (
  record: MutationRunRecord,
  path: string,
): Promise<RemoveRunResult> => {
  try {
    await removeTree(path);
    return { record, removed: true };
  } catch (error) {
    const missing = error instanceof Deno.errors.NotFound;
    return missing
      ? { record, removed: true }
      : { error, record, removed: false };
  }
};

/**
 * Delete a run's whole folder, but only when its claim has gone stale. The
 * run's own supervisor keeps the claim fresh from before the first record
 * write until after the snapshot is thrown away, so a fresh claim means the
 * folder is still someone's — `null` says it was left alone. The judgement
 * and the delete happen under the claim takers' guard: a brand-new run makes
 * its folder a moment before its claim lands in it, and holding the guard
 * keeps this from reading that moment as an abandoned run. A stale claim
 * cannot come back to life mid-delete: a run id is never claimed twice, and
 * its one owner is gone.
 */
const removeRun = (
  record: MutationRunRecord,
): Promise<RemoveRunResult | null> =>
  withRunClaimGuard(record, async () =>
    (await runClaimIsFresh(record))
      ? null
      : await removeRunPath(record, record.root),
  );

interface CleanedRuns {
  failed: Extract<RemoveRunResult, { removed: false }>[];
  removed: MutationRunRecord[];
  skipped: MutationRunRecord[];
}

/**
 * How many runs to clear away at once. Each folder is a whole checkout copy,
 * and a first run after a long time without one can find hundreds waiting —
 * deleting them all at once would swamp the disk.
 */
const RUNS_CLEARED_AT_ONCE = 8;

export const removeFinishedRuns = async (
  records: MutationRunRecord[],
): Promise<CleanedRuns> => {
  const results: {
    outcome: RemoveRunResult | null;
    record: MutationRunRecord;
  }[] = [];
  for (const someRuns of chunk(RUNS_CLEARED_AT_ONCE)(records)) {
    results.push(
      ...(await Promise.all(
        someRuns.map(async (record) => ({
          outcome: await removeRun(record),
          record,
        })),
      )),
    );
  }
  return {
    failed: results
      .map(({ outcome }) => outcome)
      .filter((outcome) => outcome?.removed === false),
    removed: results
      .filter(({ outcome }) => outcome?.removed === true)
      .map(({ record }) => record),
    skipped: results
      .filter(({ outcome }) => outcome === null || outcome === undefined)
      .map(({ record }) => record),
  };
};

export const reportRemoveFailure = (
  what: string,
  { error, record }: Extract<RemoveRunResult, { removed: false }>,
): void => {
  const subject = [what, record.id].filter(Boolean).join(" ");
  console.error(`Failed to remove ${subject}: ${errorMessage(error)}`);
};

/** Drops the snapshot of a run that has ended: it is a whole checkout copy. */
export const removeWorkSnapshot = async (
  record: MutationRunRecord,
): Promise<void> => {
  const result = await removeRunPath(record, record.workRoot);
  if (!result.removed) reportRemoveFailure("the snapshot of", result);
};

/**
 * A folder whose record cannot be read belongs to a run that was killed while
 * writing it. Stand in for that record so the folder can be judged by its
 * claim and cleared like any other — a run writing its record right now holds
 * a fresh claim, taken before the record's first write.
 */
const recordForUnreadableRun = (id: string, root: string): MutationRunRecord =>
  newRunRecord(id, [], root);

const runsToSweep = async (root: string): Promise<MutationRunRecord[]> => {
  // Only folders this runner named, and picked out before anything inside them
  // is read: whatever else sits under .mutation-runs is not ours to touch.
  const ours = (await runDirectoryNames(root)).filter(isRunId);
  return await Promise.all(
    ours.map(async (id) => {
      const record = await readRunRecord(recordPath(id, root));
      return record === null
        ? recordForUnreadableRun(id, root)
        : recordInRunDirectory(record, id, root);
    }),
  );
};

/** Clears out whatever earlier runs left behind, so nothing piles up. */
export const removeInactiveRuns = async (root: string): Promise<void> => {
  const { failed } = await removeFinishedRuns(await runsToSweep(root));
  for (const result of failed) reportRemoveFailure("the earlier run", result);
};
