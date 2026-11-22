/**
 * The branch ratchet for the test-internals registry: a branch must not leave
 * more counted imports than the merge base on `origin/main` holds.
 *
 * The registry check alone refuses a count that rises in the working tree, but
 * a branch can edit the registry by hand. This rule compares the registry with
 * the merge base instead.
 *
 * - A file that the base records must not rise.
 * - A file that the base does not record is a new file, a split, or a move.
 *   The new counts must fit inside the counts that the same branch frees:
 *   the fall in the files that the base records, including a file the branch
 *   deletes.
 */

import { sortStrings, sum } from "#fp";
import { formatFinding } from "#scripts/check-report.ts";
import type { Counts } from "#scripts/check-runner.ts";

/** Where a reader finds the rule and the way out. */
export const RATCHET_GUIDE = '"Keep tests on the public surface" in AGENTS.md';

/** The count that the branch frees: the fall in every file the base records. */
const freedBy = (base: Counts, now: Counts): number =>
  sum(
    Object.entries(base).map(([file, count]) =>
      Math.max(0, count - (now[file] ?? 0)),
    ),
  );

/** The files that the base records and the branch raises. */
const risenFindings = (base: Counts, now: Counts): string[] =>
  Object.entries(now)
    .filter(([file, count]) => file in base && count > base[file]!)
    .map(([file, count]) =>
      formatFinding(file, {
        fix: "remove the imports that the branch added",
        problem: `holds ${count} counted imports, more than the ${base[file]} on the merge base`,
        rule: "risen",
      }),
    );

/** The new files, when their counts exceed the count that the branch frees. */
const unfundedFindings = (base: Counts, now: Counts): string[] => {
  const added = Object.entries(now).filter(([file]) => !(file in base));
  const addedTotal = sum(added.map(([, count]) => count));
  const freed = freedBy(base, now);
  if (addedTotal <= freed) return [];
  return added.map(([file, count]) =>
    formatFinding(file, {
      fix: "drive the app through the driver, or free the same count in other files",
      problem: `is a new file with ${count} counted imports, and the branch frees ${freed} for ${addedTotal} new`,
      rule: "unfunded",
    }),
  );
};

/** Every finding, sorted. A missing base means that the branch adds the
 * registry, so nothing is left to compare. */
export const ratchetFindings = (
  base: Counts | undefined,
  now: Counts,
): string[] =>
  base === undefined
    ? []
    : sortStrings([
        ...risenFindings(base, now),
        ...unfundedFindings(base, now),
      ]);
