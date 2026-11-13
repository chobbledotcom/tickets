/**
 * The jscpd baseline ratchet: a branch must not raise the number of clones
 * that a `.jscpd.*baseline.json` accepts above the merge base on
 * `origin/main`. Each baseline holds one count per accepted clone
 * fingerprint, and the ratchet compares the total of those counts with the
 * base. A fingerprint can change while the clone count stays the same. A
 * lower total passes: a baseline only shrinks. See "Code Duplication" in
 * AGENTS.md.
 */

import * as v from "valibot";
import { flatMap, sort, sortStrings, sum, unique } from "#fp";
import { formatFinding } from "#scripts/check-report.ts";
import { parseJsonWith } from "#scripts/read-json.ts";
import { requireValue } from "#shared/required-value.ts";
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

/** The script a task runs when that task is a jscpd scan. */
const CPD_SCRIPT = "scripts/cpd.ts";

/** The flag each scan task gives its committed baseline, in either the
 * `--baseline <path>` or the `--baseline=<path>` form. */
const BASELINE_FLAG = /--baseline(?:=|\s+)(\S+)/g;

/** The baseline paths the `scripts/cpd.ts` tasks name, sorted and unique. A
 * scan whose baseline sits outside the names the ratchet reads can raise that
 * baseline unseen, so the check holds the two lists together. */
export const baselinePathsNamed = (
  tasks: Readonly<Record<string, string>>,
): string[] =>
  sortStrings(
    unique(
      flatMap((command: string) =>
        Array.from(command.matchAll(BASELINE_FLAG), (match) =>
          requireValue(
            match[1],
            `A cpd task names --baseline with no path: ${match[0]}`,
          ),
        ),
      )(Object.values(tasks).filter((command) => command.includes(CPD_SCRIPT))),
    ),
  );

/** The finding lines for the baselines a scan task names that the ratchet does
 * not read, in path order. The scan would raise such a baseline unseen, so the
 * baseline must be one the ratchet reads. */
export const unreadBaselineFindings = (
  named: readonly string[],
  read: readonly string[],
): string[] => {
  const readPaths = new Set(read);
  return sortStrings(named.filter((path) => !readPaths.has(path))).map((path) =>
    formatFinding(path, {
      fix:
        "keep the baseline in the repository root, named " +
        ".jscpd.<scan>-baseline.json",
      problem: "is a scan baseline that this check cannot read",
      rule: "unread-baseline",
    }),
  );
};

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

/** The number of clones a baseline accepts. */
const totalClones = (counts: FingerprintCounts): number =>
  sum(Object.values(counts));

/** The finding for one baseline file that accepts more clones than the base.
 * jscpd pairs each clone with the first match it finds, so a change in one
 * file can give a clone in an unchanged file a new fingerprint. The ratchet
 * therefore holds the total, not each fingerprint. */
const risenFindings = (
  path: string,
  head: FingerprintCounts,
  base: FingerprintCounts,
): string[] => {
  const [accepted, recorded] = [totalClones(head), totalClones(base)];
  return accepted > recorded
    ? [
        formatFinding(path, {
          fix: "merge the duplicated code, then lower the baseline with --update",
          problem: `accepts ${accepted} clone(s), up from ${recorded}`,
          rule: "raised-clones",
        }),
      ]
    : [];
};

/**
 * One baseline file's rise against the merge base.
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
