/**
 * Run a mutant's direct test files through generated entry modules so they
 * share an isolate instead of getting one each.
 *
 * `deno test` gives every file its own isolate, and each isolate re-evaluates
 * the app module graph. A mutant re-runs its whole direct set, so that cost is
 * paid once per file per mutant: measured on the admin questions template,
 * six split files took ~824ms per run against ~530ms for the same tests in one
 * file, which over a 135-mutant sweep was ~29s of the run. Importing the files
 * from one entry module — the same trick `scripts/test-groups.ts` uses for the
 * full suite — brings the split shape back to ~547ms.
 *
 * Two limits shape the entries. Files with global (module-level) BDD hooks
 * cannot share an isolate at all, so they keep their own. And an isolate is
 * capped at `MAX_FILES_PER_ENTRY` files: one process holding many test files
 * strands file descriptors (see the header of `batch.ts`), and concentrating a
 * whole batch into a single isolate would push that further than the batching
 * already allows.
 */

import { isAbsolute, join, relative } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import {
  GROUPS_DIR,
  mustRunAlone,
  renderGroupEntry,
} from "#scripts/test-groups.ts";

/** Files one generated entry may import. Below `TEST_FILE_BATCH_SIZE` so an
 *  entry never holds more open files than a batch already does. */
export const MAX_FILES_PER_ENTRY = 8;

/** Split `paths` into runs of at most `size`, preserving order. */
export const shardForEntries = (
  paths: string[],
  size = MAX_FILES_PER_ENTRY,
): string[][] => {
  const shards: string[][] = [];
  for (let index = 0; index < paths.length; index += size) {
    shards.push(paths.slice(index, index + size));
  }
  return shards;
};

/** Which files can share an isolate, and which must keep their own. */
export const splitByIsolateSharing = (
  files: { path: string; source: string }[],
): { shareable: string[]; solo: string[] } => ({
  shareable: files.filter((f) => !mustRunAlone(f.source)).map((f) => f.path),
  solo: files.filter((f) => mustRunAlone(f.source)).map((f) => f.path),
});

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

/** How an entry imports one of its members. Entries sit one level below the
 *  project root, and the paths handed in are absolute, so the specifier is the
 *  member's project-relative path with one level climbed out of the entries
 *  directory — which keeps the project's import map applying to it. */
export const entryImport = (root: string, member: string): string =>
  `../${relative(root, isAbsolute(member) ? member : join(root, member))}`;

let entrySequence = 0;

/**
 * Write one entry module per shard of shareable files and return what to run.
 * Entries import their members relative to the entries directory, so the
 * project's import map applies unchanged — which is what lets a mutated module
 * bind through its `#…` alias.
 */
export const planIsolateEntries = async (
  paths: string[],
  root: string = projectRoot,
): Promise<EntryPlan> => {
  if (paths.length < 2) return passThrough(paths);
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      source: await Deno.readTextFile(path),
    })),
  );
  const { shareable, solo } = splitByIsolateSharing(files);
  if (shareable.length < 2) return passThrough(paths);

  const entriesDir = join(root, GROUPS_DIR);
  await Deno.mkdir(entriesDir, { recursive: true });
  const written: string[] = [];
  for (const shard of shardForEntries(shareable)) {
    const entry = join(entriesDir, `mutation-${entrySequence++}.test.ts`);
    await Deno.writeTextFile(
      entry,
      renderGroupEntry(shard.map((member) => entryImport(root, member))),
    );
    written.push(entry);
  }
  return {
    cleanup: async () => {
      for (const entry of written) {
        await Deno.remove(entry).catch(rethrowUnlessGone);
      }
    },
    runArgs: [...written, ...solo],
  };
};

/** A cleanup racing another cleanup (or a wiped run directory) may find the
 *  entry already gone; anything else is a real failure. */
const rethrowUnlessGone = (error: unknown): void => {
  if (error instanceof Deno.errors.NotFound) return;
  throw error;
};
