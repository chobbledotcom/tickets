/**
 * The jscpd baseline ratchet: a branch must not accept a clone that the merge
 * base on `origin/main` does not accept. Every `.jscpd.*baseline.json` holds
 * one count per accepted clone fingerprint, so the ratchet compares those
 * counts with the base. A fingerprint the base does not hold, and a count
 * above the base's, both fail. A fingerprint that is gone, and a count below
 * the base's, pass: a baseline only shrinks. See "Code Duplication" in
 * AGENTS.md.
 */

import * as v from "valibot";
import { sort } from "#fp";
import { formatFinding } from "#scripts/check-report.ts";
import { parseJsonWith } from "#scripts/read-json.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/** The prefix every jscpd file in the repository root carries. */
const JSCPD_PREFIX = ".jscpd.";

/** The suffix that marks a committed jscpd baseline in the repository root.
 * The strict scans name theirs `<scan>-baseline.json`, and the main scan
 * names its own `.jscpd.baseline.json`. */
const BASELINE_SUFFIX = "baseline.json";

/** Where a reader finds the rule and the way out. */
export const RATCHET_GUIDE = '"Code Duplication" in AGENTS.md';

/** One accepted clone's fingerprint, and how often the scan reported it. */
export type FingerprintCounts = Record<string, number>;

/** A baseline file's shape: the version jscpd wrote, and one count per
 * accepted clone fingerprint. */
const BASELINE_SCHEMA = v.object({
  fingerprints: v.record(v.string(), integerAtLeast(0)),
  version: v.number(),
});

/** The baseline file names among `names`: the root's `.jscpd.*baseline.json`
 * files, sorted. A new scan's baseline is found without a second list to
 * keep in step. */
export const baselineFileNames = (names: readonly string[]): string[] =>
  sort((left: string, right: string) => left.localeCompare(right))(
    names.filter(
      (name) => name.startsWith(JSCPD_PREFIX) && name.endsWith(BASELINE_SUFFIX),
    ),
  );

/** One baseline file's clone counts, read from its text. Text that is not a
 * baseline fails loudly and names the file. */
export const fingerprintCounts = (
  path: string,
  text: string,
): FingerprintCounts => {
  const parsed = v.safeParse(
    BASELINE_SCHEMA,
    parseJsonWith(() => {
      throw new Error(`The jscpd baseline ${path} does not hold JSON.`);
    })(text),
  );
  if (!parsed.success) {
    throw new Error(
      `The jscpd baseline ${path} does not hold the shape jscpd writes: ` +
        v.summarize(parsed.issues),
    );
  }
  return parsed.output.fingerprints;
};

/** The finding lines for one baseline file's clones above the base's counts,
 * in fingerprint order. A fingerprint the base does not hold is absent from
 * the scan's record, so it counts as zero accepted clones there, and any
 * count above zero is a rise. */
const risenFindings = (
  path: string,
  head: FingerprintCounts,
  base: FingerprintCounts,
): string[] =>
  sort((left: [string, number], right: [string, number]) =>
    left[0].localeCompare(right[0]),
  )(
    Object.entries(head).filter(
      ([fingerprint, count]) => count > (base[fingerprint] ?? 0),
    ),
  ).map(([fingerprint, count]) => {
    const recorded = base[fingerprint];
    return recorded === undefined
      ? formatFinding(`${path}:${fingerprint}`, {
          fix: "merge the duplicated code, then lower the baseline with --update",
          problem: `holds ${count} clone(s) that the merge base does not hold`,
          rule: "added-clone",
        })
      : formatFinding(`${path}:${fingerprint}`, {
          fix: "merge the duplicated code, then lower the baseline with --update",
          problem: `holds ${count} clone(s), up from ${recorded}`,
          rule: "raised-clone",
        });
  });

/**
 * One baseline file's rises against the merge base, in fingerprint order.
 * `baseText` is undefined when the merge base holds no such file: a new
 * baseline accepts clones that main never accepted, so it fails unless it
 * holds none.
 */
export const riseFindings = (
  path: string,
  headText: string,
  baseText: string | undefined,
): string[] => {
  const head = fingerprintCounts(path, headText);
  if (baseText === undefined) {
    const accepted = Object.keys(head).length;
    return accepted === 0
      ? []
      : [
          formatFinding(path, {
            fix: "merge the duplicated code before you add the scan",
            problem: `is a new baseline that accepts ${accepted} clone(s)`,
            rule: "added-baseline",
          }),
        ];
  }
  return risenFindings(path, head, fingerprintCounts(path, baseText));
};
