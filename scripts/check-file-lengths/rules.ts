/**
 * Keep code and test files near the 400-line aim, under the 500-line limit.
 *
 * The "Keep code and test files under ~400 lines" rule in AGENTS.md aims at
 * 400 lines but enforces 500. A small edit that pushes a file slightly over
 * the aim owes a splitting issue, not an in-branch split, while a file past
 * the limit must be split or accepted on the list. Biome's hard 1,000-line
 * ceiling stays the backstop. The list only shrinks: a file that is split
 * drops its entry, and a file that grows past its recorded count fails the
 * check.
 */

import type { PerFileFinding } from "#scripts/check-runner.ts";

/** The enforced ceiling. A file over it must be split, or sit on the
 * accepted list at its recorded count. The 400-line aim is AGENTS.md
 * policy, carried by splitting issues rather than this gate. */
export const LINE_LIMIT = 500;

/** The count each accepted-over-the-limit file carried when recorded. */
export type OverLimit = Record<string, number>;

/** The lines one file's content holds. A final newline ends the last line
 * rather than starting an empty one, the way a person counts them. */
export const countLines = (content: string): number => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

/** Whether `file` sits above the limit only with the list's permission. */
export const findIssues = (
  file: string,
  content: string,
  limit: number,
  accepted: OverLimit,
): PerFileFinding[] => {
  const lines = countLines(content);
  if (lines <= limit) {
    return file in accepted
      ? [
          {
            fix: "delete the entry in scripts/check-file-lengths/over-limit.json",
            line: 1,
            problem: `holds ${lines} lines, under the ${limit}-line limit`,
            rule: "stale-entry",
          },
        ]
      : [];
  }
  const recorded = accepted[file];
  if (recorded === undefined) {
    return [
      {
        fix: "split the file",
        line: 1,
        problem: `holds ${lines} lines, over the ${limit}-line limit`,
        rule: "over-limit",
      },
    ];
  }
  if (lines > recorded) {
    return [
      {
        fix: "split the file",
        line: 1,
        problem: `grew from ${recorded} lines`,
        rule: "over-limit",
      },
    ];
  }
  if (lines < recorded) {
    return [
      {
        fix: "lower the entry in scripts/check-file-lengths/over-limit.json",
        line: 1,
        problem: `shrank from ${recorded} lines to ${lines}`,
        rule: "improved",
      },
    ];
  }
  return [];
};
