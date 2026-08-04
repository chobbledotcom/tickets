/**
 * Check that every known-equivalent mutant entry still points at a real mutant.
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
import { generateMutants } from "#scripts/mutation/generate.ts";
import {
  listRegistryFiles,
  mutantKeyForPath,
  parseRegistryText,
} from "#scripts/mutation/ignore.ts";
import { projectRoot } from "#scripts/project-root.ts";

export interface EquivalentCheckOptions {
  registryDir?: string | URL;
  root?: string;
}

interface Entry {
  key: string;
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
  registryDir: string | URL | undefined,
  root: string,
): Promise<Entry[]> => {
  const entries: Entry[] = [];
  for (const file of await listRegistryFiles(registryDir)) {
    const path = typeof file === "string" ? file : file.pathname;
    const registry = relative(root, path);
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

/** Every mutant key a source file can produce, generated exhaustively so an
 * entry for an exhaustive-only replacement still resolves. */
const keysFor = async (
  sourcePath: string,
  root: string,
): Promise<Set<string>> => {
  const file = resolve(root, sourcePath);
  const content = await Deno.readTextFile(file);
  return new Set(
    generateMutants(content, file, true).map((mutant) =>
      mutantKeyForPath(sourcePath, mutant),
    ),
  );
};

export const checkEquivalentMutants = async (
  options: EquivalentCheckOptions = {},
): Promise<string[]> => {
  const root = options.root ?? projectRoot;
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
    if (!byPath.get(entry.sourcePath)!.has(entry.key)) {
      problems.push(
        `stale (nothing to suppress — did it move or get renamed?) (${entry.registry}): ${entry.key}`,
      );
    }
  }
  return problems;
};

if (import.meta.main) {
  const problems = await checkEquivalentMutants();
  if (problems.length === 0) {
    console.log("Every equivalent-mutant entry still points at a real mutant.");
    Deno.exit(0);
  }
  console.error(problems.join("\n"));
  console.error(
    `\n${problems.length} equivalent-mutant entries need attention. Each names the` +
      "\nthing it sits inside; re-record it against where that code lives now, or" +
      "\nremove it if the expression is gone.",
  );
  Deno.exit(1);
}
