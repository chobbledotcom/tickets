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
 * a re-audit stamp and a reason:
 *
 *   path::anchor  from → to  audited:<hash>   # why it is equivalent
 *
 * The stamp is `audited:` plus the short hash of the source file's text at the
 * moment a person last re-derived the reason against that file. It is the
 * proof's date: an entry whose stamp no longer matches the file's current text
 * is unconfirmed, suppresses nothing, and is reported until someone re-derives
 * the proof and stamps the line again. A line without a stamp is malformed.
 *
 * The anchor names what the mutant sits inside and fingerprints the expression
 * it mutates (see anchor.ts), so it moves only when that expression does.
 * `ignoreListProblems` re-checks — at run time, for the files actually being
 * mutated — that each entry lines up with a real surviving mutant, so a
 * stale/redundant/duplicate/unconfirmed entry fails the run.
 */

import { fromFileUrl, join } from "@std/path";
import { namesInDirectory, readTextFileOrNull } from "#scripts/not-found.ts";
import { rel } from "#scripts/project-root.ts";
import { entryLines } from "#scripts/registry-lines.ts";
import { seenBefore } from "#shared/seen-before.ts";
import type { Mutant } from "./generate.ts";
import { percentEncode } from "./percent-encode.ts";
import type { MutantResult, Status } from "./summary.ts";

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
 * A file's path and a mutated literal's text both carry characters of their
 * own choosing onto the line, where four of them would not survive being
 * written and read back: a `#` reads as the start of the reason — or, at the
 * front, as a whole comment — a line break of any kind ends the line outright,
 * an arrow of its own reads as the one splitting `from` from `to`, and
 * whitespace at either edge is absorbed by the spacing around that arrow, which
 * would let `"; "` and `";"` share one key. Each is escaped; interior spaces
 * are left alone, so a removed statement still reads as itself.
 */
const escapeForLine = (text: string): string =>
  text
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll("→", "%e2%86%92")
    .replace(/[\n\r\u2028\u2029]/g, percentEncode)
    .replace(/^\s+/, percentEncode)
    .replace(/\s+$/, percentEncode);

/** The path a line was written with, back to the file it names — or nothing
 * when it holds a `%` that begins no escape. Escaping never writes one, so a
 * line carrying one names no real file and is malformed. */
const unescapePath = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** A path onto a line: everything `escapeForLine` handles, plus every `:`. A
 * path is the one field before the `::` that ends it, so a `::` of its own
 * would hide where it really ends; with no colon left in it, the first `::` on
 * a line is always the delimiter. */
const escapePath = (path: string): string =>
  escapeForLine(path).replaceAll(":", "%3a");

/** Canonical key for a mutant at a project-relative path. */
export const mutantKeyForPath = (relPath: string, mutant: Mutant): string =>
  `${escapePath(relPath)}::${mutant.anchor} ${escapeForLine(mutant.operator)}→${escapeForLine(mutant.newOperator)}`;

/** Canonical key for a mutant given its absolute source path. */
export const mutantKey = (file: string, mutant: Mutant): string =>
  mutantKeyForPath(rel(file), mutant);

interface ParsedIgnoreLine {
  anchor: string;
  key: string;
  newOperator: string;
  operator: string;
  /** The written proof, verbatim after the `#`. Empty when the line carries
   * none. */
  reason: string;
  sourcePath: string;
  /** The `audited:<hash>` token, kept whole so staleness compares the same
   * shape the line was written with. */
  stamp: string;
}

/** The re-audit stamp token: `audited:` plus `shortHash`'s seven base-36
 * characters. A literal the generator mutated always carries its quotes, so a
 * bare `audited:` token can only ever be the stamp. */
const STAMP_PATTERN = /(?:^|\s)(audited:[0-9a-z]{7})$/;

/** Parse one ignore-file line into a canonical key, or null when blank/comment. */
export const parseIgnoreLine = (line: string): ParsedIgnoreLine | null => {
  // A written path never starts with `#` — escaping turns one into `%23` — so
  // a line that does is a comment, with no entry it could be mistaken for.
  const text = line.trimStart();
  if (text === "" || text.startsWith("#")) return null;
  // Every field carries its own `#` escaped, so the first one left starts the
  // reason — whatever the reason then goes on to say, delimiters included.
  const reasonAt = text.indexOf("#");
  const entry = reasonAt < 0 ? text : text.slice(0, reasonAt);
  const reason = reasonAt < 0 ? "" : text.slice(reasonAt + 1).trim();
  // The path holds no colon of its own, so the first `::` ends it. The anchor
  // holds only these characters and ends at the first whitespace after it.
  const located = entry.match(/^([^:]+)::([A-Za-z0-9_$\-.%~@]+)\s+(.*)$/);
  if (!located) return null;
  // Three groups, all of them matched, or there is no match at all.
  const writtenPath = located[1]!;
  const anchor = located[2]!;
  const mutation = located[3]!;
  const sourcePath = unescapePath(writtenPath);
  if (sourcePath === null) return null;
  // `from` and `to` are escaped, so the first arrow left is the one splitting
  // them.
  const arrow = mutation.indexOf("→");
  if (arrow < 0) return null;
  // The stamp is the entry's last token, and there is exactly one of it: a
  // line resting on a proof nobody dated, or dating it twice, is malformed.
  const tail = mutation.slice(arrow + 1).trim();
  const stampMatch = STAMP_PATTERN.exec(tail);
  if (!stampMatch) return null;
  const stamp = stampMatch[1]!;
  const newOperator = tail.slice(0, tail.length - stamp.length).trimEnd();
  if (newOperator === "" || STAMP_PATTERN.test(newOperator)) return null;
  // The "from" side may be empty: an already-empty string literal mutates with
  // an empty display label (see stringLiteralMutants).
  const operator = mutation.slice(0, arrow).trimEnd();
  return {
    anchor,
    key: `${writtenPath}::${anchor} ${operator}→${newOperator}`,
    newOperator,
    operator,
    reason,
    sourcePath,
    stamp,
  };
};

export interface IgnoreList {
  /** Every parsed entry in file order, keeping duplicates for validation. Each
   * carries the path it named and the stamp it was re-derived against, so
   * scoping a run to its files never has to work that back out of the key. */
  entries: { key: string; sourcePath: string; stamp: string }[];
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
  const entries: IgnoreList["entries"] = [];
  for (const file of files) {
    // Absence is the documented empty case; a file that exists but cannot be
    // read is a real failure the run must surface, not an empty registry.
    const text = await readTextFileOrNull(file);
    if (text === null) continue;
    entries.push(
      ...parseRegistryText(text, file).map(({ key, sourcePath, stamp }) => ({
        key,
        sourcePath,
        stamp,
      })),
    );
  }
  return { entries, keys: new Set(entries.map((entry) => entry.key)) };
};

/**
 * The keys whose proof predates the file's current text: the stamp a person
 * last recorded no longer matches what the run read. An unconfirmed entry
 * suppresses nothing until someone re-derives the reason and stamps the line
 * again. Files absent from the map were never read here and cannot be judged.
 */
export const unconfirmedEntries = (
  ignore: IgnoreList,
  /** Project-relative path → the file text's short hash. */
  stampsByPath: Map<string, string>,
): Set<string> =>
  new Set(
    ignore.entries
      .filter(({ sourcePath, stamp }) => {
        const current = stampsByPath.get(sourcePath);
        return current !== undefined && `audited:${current}` !== stamp;
      })
      .map(({ key }) => key),
  );

/**
 * Whether a survivor is suppressed by a confirmed entry. A recorded key whose
 * stamp no longer matches the file's text suppresses nothing: the mutant
 * surfaces as the survivor it is, and the run reports the entry instead.
 */
export const suppresses = (
  ignore: IgnoreList,
  unconfirmed: ReadonlySet<string>,
  file: string,
  mutant: Mutant,
): boolean => {
  const key = mutantKey(file, mutant);
  return ignore.keys.has(key) && !unconfirmed.has(key);
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
  for (const line of entryLines(text)) {
    const entry = parseIgnoreLine(line);
    if (!entry) {
      throw new Error(
        `Malformed equivalent-mutant entry in ${registryFilePath(file)}: ${line}`,
      );
    }
    parsed.push(entry);
  }
  return parsed;
};

/**
 * Validate the ignore entries that target the just-mutated files against the
 * run's results. Each entry must line up with a mutant that actually survived;
 * anything else is reported so it can be fixed. Pure — the runner prints these.
 *
 *   - stale        — no mutant exists at that location, even under --exhaustive
 *                    (the code moved)
 *   - redundant    — a mutant exists there but a test kills it (not a survivor)
 *   - duplicate    — the same entry appears more than once
 *   - unconfirmed  — the entry's stamp predates the file's current text, so
 *                    its proof rests on code nobody has re-read since; the
 *                    mutant ran like any other, so the message says whether a
 *                    test already kills it (delete) or it needs re-deriving
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
 *
 * `unconfirmed` — the keys `unconfirmedEntries` judged stale-of-proof for this
 * run's files. Location staleness wins when both fire: re-recording a moved
 * entry re-derives it anyway.
 */
/**
 * One entry's problem against this run, or nothing when the entry is a
 * confirmed survivor's record. Location staleness outranks an old stamp:
 * re-recording a moved entry re-derives it anyway.
 */
const entryProblem = (
  key: string,
  state: {
    duplicate: boolean;
    killed: boolean;
    redundant: boolean;
    stale: boolean;
    unconfirmed: boolean;
  },
): string | null => {
  if (state.duplicate) return `duplicate entry: ${key}`;
  if (state.stale) {
    return `stale (no mutant here — did the code move?): ${key}`;
  }
  if (state.unconfirmed) {
    return state.killed
      ? `unconfirmed, and this run kills the mutant (delete the entry): ${key}`
      : `unconfirmed (the file changed after this proof was last re-derived — re-read the reason against the current file, then re-stamp, or delete the entry): ${key}`;
  }
  if (state.redundant) {
    return `redundant (a test kills this mutant, not a survivor): ${key}`;
  }
  return null;
};

export const ignoreListProblems = (
  ignore: IgnoreList,
  results: MutantResult[],
  mutatedFiles: string[],
  possibleKeys?: Set<string>,
  unconfirmed?: ReadonlySet<string>,
): string[] => {
  // Whole paths, not prefixes: one file's path can begin with another's.
  const relFiles = new Set(mutatedFiles.map(rel));
  const generated = new Set(results.map((r) => mutantKey(r.file, r.mutant)));
  const known = possibleKeys ?? generated;
  const keysOfStatus = (status: Status): Set<string> =>
    new Set(
      results
        .filter((r) => r.status === status)
        .map((r) => mutantKey(r.file, r.mutant)),
    );
  const suppressed = keysOfStatus("ignored");
  const killed = keysOfStatus("killed");

  const problems: string[] = [];
  const isRepeat = seenBefore();
  for (const { key, sourcePath } of ignore.entries) {
    if (!relFiles.has(sourcePath)) continue;
    const problem = entryProblem(key, {
      duplicate: isRepeat(key),
      killed: killed.has(key),
      redundant: generated.has(key) && !suppressed.has(key),
      stale: !known.has(key),
      unconfirmed: unconfirmed?.has(key) ?? false,
    });
    if (problem !== null) problems.push(problem);
  }
  return problems;
};
