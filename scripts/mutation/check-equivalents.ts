/**
 * Check that every known-equivalent mutant entry still points at a real mutant.
 *
 *
 * Resolution only: no lint, no type-check, no tests, so it is fast enough to
 * run on every commit. Re-proving that an entry is still *equivalent* applies
 * each mutant through the static gates and stays `mutation:audit-equivalents`.
 *
 * An entry fails here when it is a duplicate, when its path is not the
 * canonical project-relative one the mutation runner keys by, or when nothing
 * it could suppress exists any more.
 */

import { relative, resolve } from "@std/path";
import { requiredMapValue } from "#fp";
import { shortHash } from "#scripts/checksum.ts";
import {
  readSourceMutants,
  type SourceMutants,
  whyPathUnusable,
} from "./equivalent-registry.ts";
import {
  listRegistryFiles,
  parseRegistryText,
  registryFilePath,
} from "./ignore.ts";

interface EquivalentCheckOptions {
  /** Where the registry files live. */
  registryDir: string | URL;
  /** The project root every entry's path is written relative to. */
  root: string;
}

interface Entry {
  key: string;
  registry: string;
  sourcePath: string;
}

const readEntries = async (
  registryDir: string | URL,
  root: string,
): Promise<Entry[]> => {
  const entries: Entry[] = [];
  for (const file of await listRegistryFiles(registryDir)) {
    const registry = relative(root, registryFilePath(file));
    for (const parsed of parseRegistryText(
      await Deno.readTextFile(file),
      file,
    )) {
      entries.push({
        key: parsed.key,
        registry,
        sourcePath: parsed.sourcePath,
      });
    }
  }
  return entries;
};

/**
 * The stamp a new or re-derived entry carries for a source file as the file
 * stands now: the person re-derives the proof against the current text, then
 * writes the line with this token.
 */
export const stampForSource = async (
  root: string,
  sourcePath: string,
): Promise<string> => {
  const file = resolve(root, sourcePath);
  return `audited:${shortHash(await Deno.readTextFile(file))}`;
};

export const checkEquivalentMutants = async (
  options: EquivalentCheckOptions,
): Promise<string[]> => {
  const { root } = options;
  const entries = await readEntries(options.registryDir, root);
  const problems: string[] = [];
  const seen = new Set<string>();

  const usable = entries.filter((entry) => {
    const why = whyPathUnusable(entry.sourcePath, root);
    if (why) problems.push(`${why} (${entry.registry}): ${entry.key}`);
    return why === null;
  });

  const byPath = new Map<string, SourceMutants | null>();
  for (const sourcePath of new Set(usable.map((e) => e.sourcePath))) {
    byPath.set(sourcePath, await readSourceMutants(root, sourcePath));
  }
  for (const entry of usable) {
    if (seen.has(entry.key)) {
      problems.push(`duplicate (${entry.registry}): ${entry.key}`);
    }
    seen.add(entry.key);
    const source = requiredMapValue(byPath, entry.sourcePath);
    if (source === null || !source.mutants.has(entry.key)) {
      problems.push(
        `stale (delete the entry: no exact mutant matches) (${entry.registry}): ${entry.key}`,
      );
    }
  }
  return problems;
};
