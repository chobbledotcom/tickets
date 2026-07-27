/**
 * Which mutation runs are still going, and deleting the ones that are not.
 *
 * The supervisor in isolation.ts uses this both to clear up before a new run
 * and to serve the explicit list/kill/clean commands.
 */

import { join } from "@std/path";
import { statNumberOrNull, statOrNull } from "#scripts/not-found.ts";
import { processExists, removeTree } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";
import { runLockIsHeld, withRunLockOrNull } from "./isolation-lock.ts";
import {
  readRunRecord,
  recordInRunDirectory,
  runDirectoryNames,
} from "./isolation-records.ts";
import {
  isRunId,
  MUTATION_RECORD_FILE,
  type MutationRunRecord,
  newRunRecord,
  recordPath,
  runRoot,
  runStartedRecently,
  withinStartupGrace,
} from "./isolation-state.ts";

/** Is this record's run started, and its process still alive? */
const runProcessIsUp = (record: MutationRunRecord): boolean =>
  record.status === "running" &&
  record.pid !== undefined &&
  processExists(record.pid);

export const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> => runProcessIsUp(record) && (await runLockIsHeld(record));

/** The record as it reads on disk right now, if it can be read at all. */
const freshRecord = async (
  record: MutationRunRecord,
): Promise<MutationRunRecord | null> => {
  const latest = await readRunRecord(join(record.root, MUTATION_RECORD_FILE));
  return latest === null ? null : { ...latest, root: record.root };
};

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

type RemoveRunResult =
  | { record: MutationRunRecord; removed: true }
  | { error: unknown; record: MutationRunRecord; removed: false };

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
 * Judged from the record alone: the caller already holds the folder's lock, so
 * a live run is one whose child is up, or one so young its record may not have
 * caught up yet.
 */
const activeByRecord = (record: MutationRunRecord): boolean =>
  record.status === "copying"
    ? runStartedRecently(record)
    : runProcessIsUp(record) && runStartedRecently(record);

/**
 * Delete a run's whole folder, but only while holding its lock, and only if
 * the record read under that lock still says the run is over. Holding the lock
 * is what stops an owner claiming the folder in the moment between the two.
 * `null` means the run is still someone's, so it was left alone.
 */
const removeRun = async (
  record: MutationRunRecord,
): Promise<RemoveRunResult | null> => {
  const outcome = await withRunLockOrNull(record, async () => {
    const latest = (await freshRecord(record)) ?? record;
    return activeByRecord(latest)
      ? null
      : await removeRunPath(record, record.root);
  });
  if (outcome !== null) return outcome;
  // Nothing left to leave alone means another clear-up got there first, which
  // is the outcome we wanted, not a run we skipped.
  return (await statOrNull(record.root)) === null
    ? { record, removed: true }
    : null;
};

interface CleanedRuns {
  failed: Extract<RemoveRunResult, { removed: false }>[];
  removed: MutationRunRecord[];
  skipped: MutationRunRecord[];
}

/** Delete every run in `records` that is finished with, and say what happened. */
export const removeFinishedRuns = async (
  records: MutationRunRecord[],
): Promise<CleanedRuns> => {
  const results = await Promise.all(
    records.map(async (record) => ({
      outcome: await removeRun(record),
      record,
    })),
  );
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

/** When a folder last changed, or `null` when that cannot be told. */
const folderChangedAt = statNumberOrNull((info) => info.mtime?.getTime());

/**
 * A folder whose record cannot be read belongs to a run that was killed while
 * writing it. Stand in for that record so the folder can be checked and
 * cleared like any other.
 */
const recordForUnreadableRun = async (
  id: string,
  root: string,
): Promise<MutationRunRecord> => {
  const changedAt = await folderChangedAt(runRoot(id, root));
  // Young folders are left alone, in case a run is writing its record now —
  // and so are folders whose age cannot be told at all.
  const leaveAlone = changedAt === null || withinStartupGrace(changedAt);
  return {
    ...newRunRecord(id, [], root),
    updatedAt: leaveAlone
      ? new Date().toISOString()
      : new Date(0).toISOString(),
  };
};

const runsToSweep = async (root: string): Promise<MutationRunRecord[]> => {
  // Only folders this runner named, and picked out before anything inside them
  // is read: whatever else sits under .mutation-runs is not ours to touch.
  const ours = (await runDirectoryNames(root)).filter(isRunId);
  return await Promise.all(
    ours.map(async (id) => {
      const record = await readRunRecord(recordPath(id, root));
      return record === null
        ? await recordForUnreadableRun(id, root)
        : recordInRunDirectory(record, id, root);
    }),
  );
};

/** Clears out whatever earlier runs left behind, so nothing piles up. */
export const removeInactiveRuns = async (root: string): Promise<void> => {
  const { failed } = await removeFinishedRuns(await runsToSweep(root));
  for (const result of failed) reportRemoveFailure("the earlier run", result);
};
