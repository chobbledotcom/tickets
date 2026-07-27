/**
 * Which mutation runs are still going, and deleting the ones that are not.
 *
 * The supervisor in isolation.ts uses this both to clear up before a new run
 * and to serve the explicit list/kill/clean commands.
 */

import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { processExists, removeTree } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";
import {
  type MutationRunRecord,
  newRunRecord,
  readRunRecords,
  runDirectoryNames,
  runLockIsHeld,
  runRoot,
  runStartedRecently,
  withinStartupGrace,
} from "./isolation-state.ts";

export const processBelongsToRun = async (
  record: MutationRunRecord,
): Promise<boolean> => {
  if (record.status !== "running" || record.pid === undefined) return false;
  if (!processExists(record.pid)) return false;
  return await runLockIsHeld(record);
};

/**
 * A run that is still copying counts as active while it is young, even before
 * its lock shows: a run writes its record moments before it takes the lock, and
 * deleting its folder in that gap would pull the snapshot out from under it.
 */
const copyingRunStillActive = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "copying" &&
  (runStartedRecently(record) || (await runLockIsHeld(record)));

const runningProcessStillExists = async (
  record: MutationRunRecord,
): Promise<boolean> =>
  record.status === "running" &&
  record.pid !== undefined &&
  processExists(record.pid) &&
  (runStartedRecently(record) || (await runLockIsHeld(record)));

export const liveRunIdSet = async (
  records: MutationRunRecord[],
): Promise<Set<string>> => {
  const live = await Promise.all(
    records.map(async (record) => {
      if (record.pid === undefined) return null;
      return (await processBelongsToRun(record)) ? record.id : null;
    }),
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

export const removeRun = (
  record: MutationRunRecord,
): Promise<RemoveRunResult> => removeRunPath(record, record.root);

export const cleanableRuns = async (
  records: MutationRunRecord[],
): Promise<{
  removable: MutationRunRecord[];
  skipped: MutationRunRecord[];
}> => {
  const statuses = await Promise.all(
    records.map(async (record) => ({
      isActive:
        (await copyingRunStillActive(record)) ||
        (await runningProcessStillExists(record)),
      record,
    })),
  );
  return {
    removable: statuses
      .filter(({ isActive }) => !isActive)
      .map(({ record }) => record),
    skipped: statuses
      .filter(({ isActive }) => isActive)
      .map(({ record }) => record),
  };
};

export const reportRemoveFailure = (
  what: string,
  { error, record }: Extract<RemoveRunResult, { removed: false }>,
): void => {
  console.error(`Failed to remove ${what}${record.id}: ${errorMessage(error)}`);
};

/** Drops the snapshot of a run that has ended: it is a whole checkout copy. */
export const removeWorkSnapshot = async (
  record: MutationRunRecord,
): Promise<void> => {
  const result = await removeRunPath(record, record.workRoot);
  if (!result.removed) reportRemoveFailure("the snapshot of ", result);
};

/** When a folder last changed, or 0 when that cannot be told. */
const folderChangedAt = async (path: string): Promise<number> => {
  const info = await Deno.stat(path).catch((error: unknown) => {
    rethrowUnlessNotFound(error);
    return null;
  });
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
  const unreadable = (await runDirectoryNames(root)).filter(
    (name) => !known.has(name),
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
  const { removable } = await cleanableRuns(await runsToSweep(root));
  const results = await Promise.all(removable.map(removeRun));
  for (const result of results) {
    if (!result.removed) reportRemoveFailure("the earlier run ", result);
  }
};
