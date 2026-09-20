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

import { isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { requiredMapValue } from "#fp";
import { readTextFileOrNull } from "#scripts/not-found.ts";
import { generateMutants } from "./generate.ts";
import {
  listRegistryFiles,
  mutantKeyForPath,
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
  /** The entry's `from → to` as the key format writes it, so a candidate key
   *  carrying the same mutation compares by string equality. */
  mutation: string;
  registry: string;
  sourcePath: string;
}

/**
 * Why a path cannot be used as written, or nothing when it can.
 *
 * The runner keys a mutant by its canonical project-relative path, so any
 * other spelling of the same file — absolute, or reaching out and back —
 * resolves here while never matching what the runner suppresses.
 */
const whyPathUnusable = (sourcePath: string, root: string): string | null => {
  if (isAbsolute(sourcePath)) return "path must be relative to the project";
  const resolved = resolve(root, sourcePath);
  const canonical = relative(root, resolved);
  if (canonical === ".." || canonical.startsWith(`..${SEPARATOR}`)) {
    return "path escapes the project";
  }
  return canonical === sourcePath
    ? null
    : `path must be written as "${canonical}"`;
};

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
        mutation: `${parsed.operator}→${parsed.newOperator}`,
        registry,
        sourcePath: parsed.sourcePath,
      });
    }
  }
  return entries;
};

/**
 * Every mutant key a source file can produce, generated exhaustively so an
 * entry for an exhaustive-only replacement still resolves.
 *
 * A source the branch deleted or renamed produces none, which reads as stale —
 * the entry naming it is exactly what the author has to remove, and saying so
 * is more use than failing the commit with a file-read error.
 */
const keysFor = async (
  sourcePath: string,
  root: string,
): Promise<Set<string>> => {
  const file = resolve(root, sourcePath);
  const content = await readTextFileOrNull(file);
  if (content === null) return new Set();
  return new Set(
    generateMutants(content, file, true).map((mutant) =>
      mutantKeyForPath(sourcePath, mutant),
    ),
  );
};

/** A canonical key's `from → to`: the anchor ends at its first space, and the
 *  path before the `::` carries no raw colon. */
const mutationOfKey = (key: string): string =>
  key.slice(key.indexOf(" ", key.indexOf("::") + 2) + 1);

/** The stale line for an entry whose key resolves to nothing: each key in the
 *  file that still produces the same mutation is offered as the paste-ready
 *  replacement, and when none does the mutation is gone and the entry has to
 *  go — the entry suppresses nothing either way. */
const staleEntryProblem = (entry: Entry, keys: Set<string>): string => {
  const fresh = [...keys].filter(
    (key) => mutationOfKey(key) === entry.mutation,
  );
  const [head, ...accepts] =
    fresh.length === 0
      ? [
          `stale (nothing to suppress — the mutation no longer occurs in that file, so delete the entry) (${entry.registry}): ${entry.key}`,
        ]
      : [
          `stale (nothing to suppress — did it move or get renamed?) (${entry.registry}): ${entry.key}`,
          ...fresh.map((key) => `to accept: ${key}`),
        ];
  return [head, ...accepts].join("\n");
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

  const byPath = new Map<string, Set<string>>();
  for (const sourcePath of new Set(usable.map((e) => e.sourcePath))) {
    byPath.set(sourcePath, await keysFor(sourcePath, root));
  }
  for (const entry of usable) {
    if (seen.has(entry.key)) {
      problems.push(`duplicate (${entry.registry}): ${entry.key}`);
    }
    seen.add(entry.key);
    const keys = requiredMapValue(
      byPath,
      entry.sourcePath,
      `No mutants were generated for ${entry.sourcePath}`,
    );
    if (!keys.has(entry.key)) {
      problems.push(staleEntryProblem(entry, keys));
    }
  }
  return problems;
};
