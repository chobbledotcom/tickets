/**
 * Run a mutant's direct test files through generated entry modules so they
 * share an isolate instead of getting one each.
 *
 * `deno test` gives every test file its own isolate, and each isolate
 * re-evaluates the app module graph. A mutant re-runs its whole direct set, so
 * that cost is paid per file per mutant: measured on the admin questions
 * template, six split files took ~824ms per run against ~530ms for the same
 * tests in one file, which over a 135-mutant sweep was ~29s. Reusing the full
 * suite's grouping — one entry module importing several test files — brings the
 * split shape back to ~547ms, so splitting an oversized test file no longer
 * costs anything at mutation time.
 *
 * Two limits shape the entries, both inherited from the mechanisms this builds
 * on. Files with global (module-level) BDD hooks cannot share an isolate, so
 * `planTestGroups` keeps them on their own. And an entry holds at most
 * `MAX_FILES_PER_ENTRY` files: one process holding many test files strands file
 * descriptors (see the header of `batch.ts`), and pulling a whole batch into a
 * single isolate would push that past what the batching already allows.
 */

import { projectRoot } from "#scripts/project-root.ts";
import {
  classifyRunAlone,
  planTestGroups,
  writeGroupEntries,
} from "#scripts/test-groups.ts";

/** Files one generated entry may import. Below `TEST_FILE_BATCH_SIZE` so an
 *  entry never holds more open files than a batch already does. */
export const MAX_FILES_PER_ENTRY = 8;

export interface EntryPlan {
  /** Remove the generated entries. */
  cleanup: () => Promise<void>;
  /** Paths to hand to `deno test`: generated entries plus solo files. */
  runArgs: string[];
}

/** A single file is already one isolate, so it is handed through untouched. */
const passThrough = (paths: string[]): EntryPlan => ({
  cleanup: () => Promise.resolve(),
  runArgs: paths,
});

/** Entries per run of files, so no entry exceeds MAX_FILES_PER_ENTRY. */
export const entryCountFor = (shareableFiles: number): number =>
  Math.ceil(shareableFiles / MAX_FILES_PER_ENTRY);

let entrySequence = 0;

/** Plan and write the entry modules for one set of direct test files. */
export const planIsolateEntries = async (
  paths: string[],
  root: string = projectRoot,
): Promise<EntryPlan> => {
  if (paths.length < 2) return passThrough(paths);
  const files = await classifyRunAlone(paths);
  const shareable = files.filter((file) => !file.runsAlone).length;
  if (shareable < 2) return passThrough(paths);

  const plan = planTestGroups(files, entryCountFor(shareable));
  // Concurrent batch workers each write their own entries, so names carry a
  // run-wide sequence number rather than only a per-call index.
  const base = entrySequence;
  entrySequence += plan.grouped.length;
  const entries = await writeGroupEntries(
    root,
    plan.grouped,
    (index) => `mutation-${base + index}.test.ts`,
  );
  return {
    cleanup: entries.cleanup,
    runArgs: [...entries.paths, ...plan.solo],
  };
};
