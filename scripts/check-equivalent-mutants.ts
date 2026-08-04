/**
 * Check that every known-equivalent mutant entry still points at a real mutant.
 *
 * This is the cheap half of `mutation:audit-equivalents`: it only resolves
 * entries against freshly generated mutants, running no lint, no type-check and
 * no tests, so it is fast enough for `precommit`. Re-proving that each entry is
 * still *equivalent* is the expensive half and stays an on-demand tool.
 *
 * It exists because drift used to be found in review. An entry that no longer
 * resolves stops suppressing its mutant, and the next mutation run fails
 * somewhere else entirely — on a branch that may not be the one that moved it.
 */

import { relative, resolve } from "@std/path";
import { generateMutants } from "#scripts/mutation/generate.ts";
import {
  listRegistryFiles,
  mutantKeyForPath,
  parseRegistryText,
} from "#scripts/mutation/ignore.ts";
import { projectRoot } from "#scripts/project-root.ts";

interface Entry {
  key: string;
  registry: string;
  sourcePath: string;
}

/** Every entry across the registry, with the file it was read from. */
const readEntries = async (): Promise<Entry[]> => {
  const entries: Entry[] = [];
  for (const file of await listRegistryFiles()) {
    const path = typeof file === "string" ? file : file.pathname;
    const registry = relative(projectRoot, path);
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

/** Every mutant key a source file can produce, under exhaustive generation so
 * an entry for an exhaustive-only replacement still resolves. */
const keysFor = async (sourcePath: string): Promise<Set<string>> => {
  const file = resolve(projectRoot, sourcePath);
  const content = await Deno.readTextFile(file);
  return new Set(
    generateMutants(content, file, true).map((mutant) =>
      mutantKeyForPath(sourcePath, mutant),
    ),
  );
};

export const checkEquivalentMutants = async (): Promise<string[]> => {
  const entries = await readEntries();
  const problems: string[] = [];
  const seen = new Set<string>();
  const byPath = new Map<string, Set<string>>();
  for (const sourcePath of new Set(entries.map((e) => e.sourcePath))) {
    byPath.set(sourcePath, await keysFor(sourcePath));
  }
  for (const entry of entries) {
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
