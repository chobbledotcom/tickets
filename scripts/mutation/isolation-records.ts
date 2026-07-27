/**
 * Reading and writing the small record each mutation run keeps on disk.
 */

import { dirname, join } from "@std/path";
import { nullIfNotFound, rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  MUTATION_RECORD_FILE,
  type MutationRunRecord,
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
export const readRunRecord = async (
  path: string,
): Promise<MutationRunRecord | null> => {
  const text = await nullIfNotFound(Deno.readTextFile(path));
  if (text === null) return null;
  try {
    return JSON.parse(text) as MutationRunRecord;
  } catch {
    // A run killed mid-write leaves half a record behind.
    return null;
  }
};

const recordInCurrentRunDirectory = (
  record: MutationRunRecord,
  id: string,
  root = projectRoot,
): MutationRunRecord => ({
  ...record,
  id,
  root: runRoot(id, root),
  workRoot: workRoot(id, root),
});

/** Every run folder, whether or not it still holds a readable record. */
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

export const readRunRecords = async (
  root = projectRoot,
): Promise<MutationRunRecord[]> => {
  const records: MutationRunRecord[] = [];
  for (const name of await runDirectoryNames(root)) {
    const record = await readRunRecord(recordPath(name, root));
    if (record) records.push(recordInCurrentRunDirectory(record, name, root));
  }
  return records.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
};
