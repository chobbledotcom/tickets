/**
 * The coverage exclusion ratchet: a branch must not add an entry to
 * `scripts/check-coverage-exclusions/exclusions.ts`, compared with the merge
 * base on `origin/main`. Removing an entry is always allowed, and so is
 * reordering. See "Never add a coverage exclusion" in AGENTS.md.
 */

import { formatFinding } from "#scripts/check-report.ts";

/** The data module the ratchet diffs, at HEAD and at the merge base. */
export const EXCLUSIONS_PATH =
  "scripts/check-coverage-exclusions/exclusions.ts";

/** Where the list lived before the move out of the gate module. The ratchet
 * reads this file at the merge base when the data module did not exist
 * there, so the ratchet's own introduction does not report the whole moved
 * list as added. */
export const LEGACY_PATH = "scripts/coverage-check.ts";

/** Where a reader finds the rule and the way out. */
export const RATCHET_GUIDE =
  '"Never add a coverage exclusion" in AGENTS.md and ' +
  "docs/designing-systems.md#readable-by-the-coverage-merge";

/** One added exclusion, as the ratchet reports it. */
export type AddedExclusion = {
  /** The excluded path, exactly as the entry names it. */
  path: string;
  /** The 1-based line of the added entry in the HEAD data module. */
  line: number;
};

/** One entry line's shape: a double-quoted path at a two-space indent, an
 * optional trailing comma, an optional trailing comment, and an optional
 * carriage return (a CRLF checkout must parse the same way). */
const ENTRY_LINE = /^ {2}"([^"]+)",?\r?(?:\s*\/\/.*)?$/;

/** The same shape anchored on one exact path, for finding its line. */
export const entryLine = (path: string): RegExp =>
  new RegExp(
    `^ {2}"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",?\\r?(?:\\s*\\/\\/.*)?$`,
  );

/**
 * Read the exclusion entries out of the data module's text: one entry per
 * line in the shape {@link ENTRY_LINE} matches. Comment lines and blank
 * lines carry no entries.
 */
export const parseExclusionEntries = (source: string): string[] =>
  source
    .split("\n")
    .map((line) => line.match(ENTRY_LINE)?.[1])
    .filter((entry): entry is string => entry !== undefined);

/**
 * The entries HEAD adds against the merge base, in HEAD's order. A removed
 * or reordered entry is never added, so removals and moves pass freely.
 */
export const addedExclusions = (
  head: readonly string[],
  base: readonly string[],
): string[] => {
  const basePaths = new Set(base);
  return head.filter((path) => !basePaths.has(path));
};

/** The finding lines for the entries HEAD added, in file order. */
export const exclusionFindings = (
  headSource: string,
  baseEntries: readonly string[],
): string[] => {
  const lines = headSource.split("\n");
  return addedExclusions(parseExclusionEntries(headSource), baseEntries).map(
    (path) => {
      const line = lines.findIndex((text) => entryLine(path).test(text)) + 1;
      return formatFinding(`${EXCLUSIONS_PATH}:${line}`, {
        fix:
          "restructure the code so that the coverage merge reads it. " +
          "Read docs/designing-systems.md#readable-by-the-coverage-merge.",
        problem: `"${path}" is a new coverage exclusion (the list only shrinks)`,
        rule: "added-exclusion",
      });
    },
  );
};
