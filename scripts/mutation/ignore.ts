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
 * Works for every mutation kind, not just `?? → ||`. One entry per line, plus
 * an optional reason:
 *
 *   path::anchor  from → to   # why it is equivalent
 *
 * The anchor names what the mutant sits inside and fingerprints the expression
 * it mutates (see anchor.ts), so it moves only when that expression does.
 * `ignoreListProblems` re-checks — at run time, for the files actually being
 * mutated — that each entry lines up with a real surviving mutant, so a
 * stale/redundant/duplicate entry fails the run.
 */

import { fromFileUrl, join } from "@std/path";
import { namesInDirectory, readTextFileOrNull } from "#scripts/not-found.ts";
import { rel } from "#scripts/project-root.ts";
import { seenBefore } from "#shared/seen-before.ts";
import type { Mutant } from "./generate.ts";
import { percentEncode } from "./percent-encode.ts";
import type { MutantResult } from "./summary.ts";

export const EQUIVALENT_MUTANTS_DIR = new URL(
  "./equivalent-mutants/",
  import.meta.url,
);

/** Every registry file in the directory, in name order so loads are stable.
 * A checkout without the directory simply has no records, so it reads empty. */
/** A registry file as a plain path, whichever form the listing produced. */
export const registryFilePath = (file: string | URL): string =>
  typeof file === "string" ? file : fromFileUrl(file);

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

/**
 * A mutated literal carries its own text into the displayed `from → to`, where
 * four things would not survive being written to a line and read back: a `#`
 * reads as the start of the reason, a line break of any kind ends the line
 * outright, an arrow of its own reads as the one splitting `from` from `to`,
 * and whitespace at either edge is absorbed by the spacing around that arrow —
 * which would let `"; "` and `";"` share one key. Each is escaped; interior
 * spaces are left alone, so a removed statement still reads as itself.
 */
const escapeForLine = (text: string): string =>
  text
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll("→", "%e2%86%92")
    .replace(/[\n\r\u2028\u2029]/g, percentEncode)
    .replace(/^\s+/, percentEncode)
    .replace(/\s+$/, percentEncode);

/** Canonical key for a mutant at a project-relative path. */
export const mutantKeyForPath = (relPath: string, mutant: Mutant): string =>
  `${relPath}::${mutant.anchor} ${escapeForLine(mutant.operator)}→${escapeForLine(mutant.newOperator)}`;

/** Canonical key for a mutant given its absolute source path. */
export const mutantKey = (file: string, mutant: Mutant): string =>
  mutantKeyForPath(rel(file), mutant);

interface ParsedIgnoreLine {
  anchor: string;
  key: string;
  newOperator: string;
  operator: string;
  sourcePath: string;
}

/** Parse one ignore-file line into a canonical key, or null when blank/comment. */
export const parseIgnoreLine = (line: string): ParsedIgnoreLine | null => {
  // A whole-line comment is not an entry, however much of one it quotes.
  const text = line.trimStart();
  if (text === "" || text.startsWith("#")) return null;
  // Past that, only the `to` side can be followed by a reason, so that is the
  // only place a `#` starts one. Everything before the arrow is read as
  // written, which leaves a path free to hold a `#`, a space, or both. `from`
  // and `to` are escaped, so the first arrow on the line is always this one.
  const arrow = text.indexOf("→");
  if (arrow < 0) return null;
  const newOperator = text
    .slice(arrow + 1)
    .replace(/\s#.*$/, "")
    .trim();
  if (newOperator === "") return null;
  // The "from" side is `.*?` (not `.+?`): an already-empty string literal
  // mutates with an empty display label (see stringLiteralMutants), so a
  // legitimate key can have nothing between the location and the arrow. An
  // anchor never holds a `::`, so the last one ends the path.
  const match = text.slice(0, arrow).match(/^(.+)::(\S+)\s+(.*?)\s*$/);
  return match
    ? {
        anchor: match[2]!,
        key: `${match[1]}::${match[2]} ${match[3]}→${newOperator}`,
        newOperator,
        operator: match[3]!,
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
    // Absence is the documented empty case; a file that exists but cannot be
    // read is a real failure the run must surface, not an empty registry.
    const text = await readTextFileOrNull(file);
    if (text === null) continue;
    entries.push(...parseRegistryText(text, file).map((entry) => entry.key));
  }
  return { entries, keys: new Set(entries) };
};

/**
 * Every entry in one registry file's text.
 *
 * A line that is neither blank nor a comment but does not parse raises, because
 * a registry quietly missing part of itself reads exactly like one that never
 * held those entries.
 */
export const parseRegistryText = (
  text: string,
  file: string | URL,
): ParsedIgnoreLine[] => {
  const parsed: ParsedIgnoreLine[] = [];
  for (const line of text.split("\n")) {
    const entry = parseIgnoreLine(line);
    if (entry) {
      parsed.push(entry);
      continue;
    }
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
      throw new Error(
        `Malformed equivalent-mutant entry in ${registryFilePath(file)}: ${line}`,
      );
    }
  }
  return parsed;
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
