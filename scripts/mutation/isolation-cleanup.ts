/**
 * Which mutation runs are still going, and deleting the ones that are not.
 *
 * The supervisor in isolation.ts uses this both to clear up before a new run
 * and to serve the explicit list/kill/clean commands.
 */

import { join } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { processExists, removeTree } from "#scripts/process.ts";
import { errorMessage } from "#shared/error-message.ts";
import { runLockIsHeld } from "./isolation-lock.ts";
import {
  readRunRecord,
  readRunRecords,
  runDirectoryNames,
} from "./isolation-records.ts";
import {
  MUTATION_RECORD_FILE,
  MUTATION_RUN_ID_PREFIX,
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

/**
 * A run that looks alive still counts as active while it is young, before its
 * lock shows: a run writes its record moments before it takes the lock, and
 * deleting its folder in that gap would pull the work out from under it.
 */
const stillActive =
  (looksAlive: (record: MutationRunRecord) => boolean) =>
  async (record: MutationRunRecord): Promise<boolean> =>
    looksAlive(record) &&
    (runStartedRecently(record) || (await runLockIsHeld(record)));

const copyingRunStillActive = stillActive(
  (record) => record.status === "copying",
);

const runningProcessStillExists = stillActive(runProcessIsUp);

const looksActive = async (record: MutationRunRecord): Promise<boolean> =>
  (await copyingRunStillActive(record)) ||
  (await runningProcessStillExists(record));

/**
 * A run counts as active if either the record we started from, or the one on
 * disk now, says so. Waiting on the lock takes time, and the run can move from
 * copying to running while we wait — the record we read first is by then out of
 * date, and acting on it would delete a run that had just come to life.
 */
const runIsActive = async (record: MutationRunRecord): Promise<boolean> => {
  if (await looksActive(record)) return true;
  // Whoever holds the folder's lock owns it, whatever its record says — the
  // supervisor takes it again to write its last record once its child has gone.
  if (await runLockIsHeld(record)) return true;
  const latest = await readRunRecord(join(record.root, MUTATION_RECORD_FILE));
  return (
    latest !== null && (await looksActive({ ...latest, root: record.root }))
  );
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
      isActive: await runIsActive(record),
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
  // Only folders this runner named: anything else under .mutation-runs was
  // put there by someone else and is not ours to delete.
  const unreadable = (await runDirectoryNames(root)).filter(
    (name) => !known.has(name) && name.startsWith(MUTATION_RUN_ID_PREFIX),
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
    if (!result.removed) reportRemoveFailure("the earlier run", result);
  }
};
