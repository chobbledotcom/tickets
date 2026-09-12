/**
 * Keep code and test files under the ~400-line limit.
 *
 * The "Keep code and test files under ~400 lines" rule in AGENTS.md says a
 * file stays under 400 lines, with Biome's hard 1,000-line ceiling as the
 * backstop. This module is the ratchet between the two: a file over the
 * limit must be on the accepted list, an entry records the count its file
 * carried when the list was last lowered, and a file that shrank must have
 * its entry lowered too. The list only shrinks — a file is split, its entry
 * goes; a file grows, the check fails.
 */

import type { PerFileFinding } from "#scripts/check-runner.ts";

/** The limit the guide aims for. */
export const LINE_LIMIT = 400;

/** The count each accepted-over-the-limit file carried when recorded. */
export type OverLimit = Record<string, number>;

/** The lines one file's content holds. */
export const countLines = (content: string): number =>
  content.split("\n").length;

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
