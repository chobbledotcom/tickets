/**
 * Known-equivalent mutant ignore-list.
 *
 * Some surviving mutants are *equivalent*: no possible input distinguishes the
 * mutated code from the original (e.g. `x ?? ""` vs `x || ""` when the only
 * falsy value `x` can take is `""`, or `a - b` in a sort over an already-sorted
 * index array). They can never be killed, so once one is confirmed equivalent
 * it is recorded here and suppressed from the survivor count — letting the
 * tester gate CI on genuinely *new* survivors.
 *
 * Works for every mutation kind, not just `?? → ||`: an entry is matched purely
 * by location and the displayed `from → to`, so it mirrors a survivor line from
 * the report. The file format is one entry per line, plus an optional reason:
 *
 *   path:line:col  from → to   # why it is equivalent
 *
 * Entries are location-based, so a refactor that shifts lines silently leaves
 * them pointing at nothing. `ignoreListProblems` re-checks — at run time, only
 * for the files actually being mutated — that each entry still lines up with a
 * real surviving mutant, so a stale/redundant/duplicate entry fails the run.
 */

import { join } from "@std/path";
import { namesInDirectory, rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { seenBefore } from "#shared/seen-before.ts";
import type { Mutant } from "./generate.ts";
import { type MutantResult, rel } from "./summary.ts";

export const EQUIVALENT_MUTANTS_DIR = new URL(
  "./equivalent-mutants/",
  import.meta.url,
);

/** Every registry file in the directory, in name order so loads are stable.
 * A checkout without the directory simply has no records, so it reads empty. */
export const listRegistryFiles = async (
  dir: string | URL = EQUIVALENT_MUTANTS_DIR,
): Promise<(string | URL)[]> => {
  const names = await namesInDirectory(
    dir,
    (item) => item.isFile && item.name.endsWith(".txt"),
  );
  names.sort();
  return names.map((name) =>
    typeof dir === "string" ? join(dir, name) : new URL(name, dir),
  );
};

/** Canonical key for a mutant at a project-relative path. */
export const mutantKeyForPath = (relPath: string, mutant: Mutant): string =>
  `${relPath}:${mutant.line}:${mutant.column} ${mutant.operator}→${mutant.newOperator}`;

/** Canonical key for a mutant given its absolute source path. */
export const mutantKey = (file: string, mutant: Mutant): string =>
  mutantKeyForPath(rel(file), mutant);

export interface ParsedIgnoreLine {
  column: number;
  key: string;
  line: number;
  newOperator: string;
  operator: string;
  sourcePath: string;
}

/** Parse one ignore-file line into a canonical key, or null when blank/comment. */
export const parseIgnoreLine = (line: string): ParsedIgnoreLine | null => {
  const body = line.replace(/#.*$/, "").trim();
  if (body === "") return null;
  // The "from" side is `.*?` (not `.+?`): an already-empty string literal
  // mutates with an empty display label (see stringLiteralMutants), so a
  // legitimate key can have nothing between the location and the arrow.
  const match = body.match(/^(.+):(\d+):(\d+)\s+(.*?)\s*→\s*(.+?)$/);
  return match
    ? {
        column: Number(match[3]),
        key: `${match[1]}:${match[2]}:${match[3]} ${match[4]}→${match[5]}`,
        line: Number(match[2]),
        newOperator: match[5]!,
        operator: match[4]!,
        sourcePath: match[1]!,
      }
    : null;
};

export interface IgnoreList {
  /** Every parsed entry in file order, keeping duplicates for validation. */
  entries: string[];
  /** Unique entry keys, for the membership check during evaluation. */
  keys: Set<string>;
}

/** Load the ignore-list from the given registry files, defaulting to every
 * file in the registry directory (empty when a file or the directory is
 * absent — a checkout without records is a valid, empty registry). */
export const loadIgnoreList = async (
  ignoreFiles?: (string | URL)[],
): Promise<IgnoreList> => {
  const files = ignoreFiles ?? (await listRegistryFiles());
  const entries: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch (error) {
      // Absence is the documented empty case; a file that exists but cannot
      // be read is a real failure the run must surface, not an empty registry.
      rethrowUnlessNotFound(error);
      continue;
    }
    entries.push(
      ...text
        .split("\n")
        .map(parseIgnoreLine)
        .filter((entry): entry is ParsedIgnoreLine => entry !== null)
        .map((entry) => entry.key),
    );
  }
  return { entries, keys: new Set(entries) };
};

/** Whether a survivor is a recorded known-equivalent mutant. */
export const isIgnored = (
  ignore: IgnoreList,
  file: string,
  mutant: Mutant,
): boolean => ignore.keys.has(mutantKey(file, mutant));

/**
 * Validate the ignore entries that target the just-mutated files against the
 * run's results. Each entry must line up with a mutant that actually survived;
 * anything else is reported so it can be fixed. Pure — the runner prints these.
 *
 *   - stale     — no mutant exists at that location, even under --exhaustive
 *                 (the code moved)
 *   - redundant — a mutant exists there but a test kills it (not a survivor)
 *   - duplicate — the same entry appears more than once
 *
 * Scoped to `mutatedFiles`: an entry for a file you are not testing right now
 * can't be checked, and doesn't matter until you do.
 *
 * `possibleKeys` — every key `generateMutants` could produce for the mutated
 * files under --exhaustive, regardless of the mode this run actually used.
 * Without it, staleness is checked only against `results` (this run's own
 * mutants), which makes an entry for an --exhaustive-only replacement (e.g.
 * an extra number-literal offset, or `=== → ==`, only added in exhaustive
 * mode) falsely "stale" during the default-mode precommit gate. When
 * `possibleKeys` confirms a key is real but this run didn't generate it (a
 * non-exhaustive run skipping an exhaustive-only mutant), the entry is ignored
 * as unverified-this-run rather than flagged — it can still be confirmed
 * "redundant" by a later --exhaustive run. Defaults to the tested set alone
 * for callers that don't have the wider set (and existing tests).
 */
export const ignoreListProblems = (
  ignore: IgnoreList,
  results: MutantResult[],
  mutatedFiles: string[],
  possibleKeys?: Set<string>,
): string[] => {
  const relFiles = mutatedFiles.map(rel);
  const targetsMutatedFile = (key: string): boolean =>
    relFiles.some((file) => key.startsWith(`${file}:`));
  const generated = new Set(results.map((r) => mutantKey(r.file, r.mutant)));
  const known = possibleKeys ?? generated;
  const suppressed = new Set(
    results
      .filter((r) => r.status === "ignored")
      .map((r) => mutantKey(r.file, r.mutant)),
  );

  const problems: string[] = [];
  const isRepeat = seenBefore();
  for (const key of ignore.entries) {
    if (!targetsMutatedFile(key)) continue;
    if (isRepeat(key)) {
      problems.push(`duplicate entry: ${key}`);
      continue;
    }
    if (!known.has(key)) {
      problems.push(`stale (no mutant here — did the code move?): ${key}`);
    } else if (generated.has(key) && !suppressed.has(key)) {
      problems.push(
        `redundant (a test kills this mutant, not a survivor): ${key}`,
      );
    }
  }
  return problems;
};
