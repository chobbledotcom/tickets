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
 */

import type { Mutant } from "./generate.ts";
import { rel } from "./summary.ts";

const IGNORE_FILE = new URL("./equivalent-mutants.txt", import.meta.url);

/** Canonical key for a mutant at a project-relative path. */
const keyFor = (relPath: string, mutant: Mutant): string =>
  `${relPath}:${mutant.line}:${mutant.column} ${mutant.operator}→${mutant.newOperator}`;

/** Parse one ignore-file line into a canonical key, or null when blank/comment. */
const parseLine = (line: string): string | null => {
  const body = line.replace(/#.*$/, "").trim();
  if (body === "") return null;
  const match = body.match(/^(.+:\d+:\d+)\s+(.+?)\s*→\s*(.+?)$/);
  return match ? `${match[1]} ${match[2]}→${match[3]}` : null;
};

/** Load the ignore-list into a set of canonical keys (empty when absent). */
export const loadIgnoreList = async (): Promise<Set<string>> => {
  let text: string;
  try {
    text = await Deno.readTextFile(IGNORE_FILE);
  } catch {
    return new Set();
  }
  const keys = text
    .split("\n")
    .map(parseLine)
    .filter((key): key is string => key !== null);
  return new Set(keys);
};

/** Whether a survivor is a recorded known-equivalent mutant. */
export const isIgnored = (
  ignore: Set<string>,
  file: string,
  mutant: Mutant,
): boolean => ignore.has(keyFor(rel(file), mutant));
