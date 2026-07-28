/**
 * Reading and writing the small record each mutation run keeps on disk.
 */

/* jscpd:ignore-start */
import { dirname, join } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { readJsonOrNull } from "#scripts/read-json.ts";
/* jscpd:ignore-end */
import {
  isRunId,
  MUTATION_RECORD_FILE,
  type MutationRunRecord,
  MutationRunRecordSchema,
  recordPath,
  runRoot,
  runsRoot,
  workRoot,
} from "./isolation-state.ts";

const MUTATION_RECORD_PENDING_SUFFIX = ".writing";

/**
 * Write the record in one step: the new text goes to a spare file that is then
 * swapped into place, so another run reading at that moment sees either the
 * old record or the new one — never half of one.
 */
export const writeRunRecord = async (
  record: MutationRunRecord,
): Promise<void> => {
  const path = join(record.root, MUTATION_RECORD_FILE);
  await Deno.mkdir(dirname(path), { recursive: true });
  const pending = `${path}${MUTATION_RECORD_PENDING_SUFFIX}`;
  await Deno.writeTextFile(pending, `${JSON.stringify(record, null, 2)}\n`);
  await Deno.rename(pending, path);
};

/**
 * The record at `path`, or `null` when there is none to read or it is half
 * written. A disk that cannot be read at all is a different matter and throws:
 * treating it as "no record" would let a live run be cleared away.
 */
export const readRunRecord = (
  path: string,
): Promise<MutationRunRecord | null> =>
  readJsonOrNull(path, MutationRunRecordSchema);

/** The record as it applies to this checkout, wherever it was written. */
export const recordInRunDirectory = (
  record: MutationRunRecord,
  id: string,
  root = projectRoot,
): MutationRunRecord => ({
  ...record,
  id,
  root: runRoot(id, root),
  workRoot: workRoot(id, root),
});

/** Every folder under .mutation-runs, ours or not. Callers that go on to act on
 * a folder pick out the ones this runner named with `isRunId` first. */
export const runDirectoryNames = async (
  root = projectRoot,
): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(runsRoot(root))) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
  return names;
};

/**
 * The runs this runner made, newest first. Folders it did not name are left out
 * before anything inside them is read, so a stray folder that happens to hold a
 * readable record — somebody's copied backup of an old run, say — is never
 * listed, killed or deleted by `--clean all`.
 */
export const readRunRecords = async (
  root = projectRoot,
): Promise<MutationRunRecord[]> => {
  const records: MutationRunRecord[] = [];
  for (const name of (await runDirectoryNames(root)).filter(isRunId)) {
    const record = await readRunRecord(recordPath(name, root));
    if (record) records.push(recordInRunDirectory(record, name, root));
  }
  return records.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
};
