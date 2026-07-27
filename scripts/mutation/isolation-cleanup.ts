/**
 * Which mutation runs are still going, and deleting the ones that are not.
 *
 * The supervisor in isolation.ts uses this both to clear up before a new run
 * and to serve the explicit list/kill/clean commands.
 */

import { join } from "@std/path";
import { nullIfNotFound } from "#scripts/not-found.ts";
import { processExists, removeTree } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";
import { runLockIsHeld, withRunLockIfFree } from "./isolation-lock.ts";
import {
  readRunRecord,
  readRunRecords,
  runDirectoryNames,
} from "./isolation-records.ts";
import {
  isRunId,
  MUTATION_RECORD_FILE,
  type MutationRunRecord,
  newRunRecord,
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

export type RemoveRunResult =
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
export const removeRun = (
  record: MutationRunRecord,
): Promise<RemoveRunResult | null> =>
  withRunLockIfFree(record, async () => {
    const latest = (await freshRecord(record)) ?? record;
    return activeByRecord(latest)
      ? null
      : await removeRunPath(record, record.root);
  });

export interface CleanedRuns {
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

/** When a folder last changed, or 0 when that cannot be told. */
const folderChangedAt = async (path: string): Promise<number> => {
  const info = await nullIfNotFound(Deno.stat(path));
  return info?.mtime?.getTime() ?? 0;
};

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
  return {
    ...newRunRecord(id, [], root),
    // Young folders are left alone, in case a run is writing its record now.
    updatedAt: withinStartupGrace(changedAt)
      ? new Date().toISOString()
      : new Date(0).toISOString(),
  };
};

const runsToSweep = async (root: string): Promise<MutationRunRecord[]> => {
  const records = await readRunRecords(root);
  const known = new Set(records.map((record) => record.id));
  // Only folders this runner named: anything else under .mutation-runs was
  // put there by someone else and is not ours to delete.
  const unreadable = (await runDirectoryNames(root)).filter(
    (name) => !known.has(name) && isRunId(name),
  );
  return [
    ...records,
    ...(await Promise.all(
      unreadable.map((id) => recordForUnreadableRun(id, root)),
    )),
  ];
};

/** Clears out whatever earlier runs left behind, so nothing piles up. */
export const removeInactiveRuns = async (root: string): Promise<void> => {
  const { failed } = await removeFinishedRuns(await runsToSweep(root));
  for (const result of failed) reportRemoveFailure("the earlier run", result);
};
