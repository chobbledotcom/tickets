/**
 * The jscpd baseline ratchet: a branch must not accept a clone that the merge
 * base on `origin/main` does not accept. Every `.jscpd.*baseline.json` holds
 * one count per accepted clone fingerprint, so the ratchet compares those
 * counts with the base. A fingerprint the base does not hold, and a count
 * above the base's, both fail. A fingerprint that is gone, and a count below
 * the base's, pass: a baseline only shrinks. The one accepted rise is a
 * re-paired clone (see ./re-pairs.ts). See "Code Duplication" in AGENTS.md.
 */

import { basename } from "node:path";
import * as v from "valibot";
import { flatMap, sort, sortStrings, unique } from "#fp";
import { formatFinding } from "#scripts/check-report.ts";
import { parseJsonWith } from "#scripts/read-json.ts";
import { requireValue } from "#shared/required-value.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/** The prefix every committed jscpd baseline carries. */
const JSCPD_PREFIX = ".jscpd.";

/** The suffix that marks a committed jscpd baseline in `cfg/`. The strict
 * scans name theirs `<scan>-baseline.json`, and the main scan names its own
 * `.jscpd.baseline.json`. */
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

/** The baseline file names among `names`: the `.jscpd.*baseline.json` files
 * that `cfg/` holds, sorted. A new scan's baseline is found without a second
 * list to keep in step. */
export const baselineFileNames = (names: readonly string[]): string[] =>
  sort((left: string, right: string) => left.localeCompare(right))(
    names.filter(
      (name) => name.startsWith(JSCPD_PREFIX) && name.endsWith(BASELINE_SUFFIX),
    ),
  );

/** The path among `paths` that holds the baseline named like `headPath`, or
 * undefined when the base holds none. A baseline is identified by its file
 * name, so a baseline that moves between directories is not a new one. */
export const basePathFor = (
  paths: readonly string[],
  headPath: string,
): string | undefined => {
  const name = basename(headPath);
  const matches = paths.filter((path) => basename(path) === name);
  if (matches.length > 1) {
    throw new Error(
      `The merge base holds more than one file named ${name}: ` +
        `${matches.join(", ")}.`,
    );
  }
  return matches[0];
};

/** The script a task runs when that task is a jscpd scan. */
const CPD_SCRIPT = "scripts/cpd.ts";

/** Reads a list out of the repository's tasks: each name and its command. */
type TaskReader = (tasks: Readonly<Record<string, string>>) => string[];

/** The commands of the tasks that run a jscpd scan. */
export const scanCommands: TaskReader = (tasks) =>
  Object.values(tasks).filter((command) => command.includes(CPD_SCRIPT));

/** The flag each scan task gives its committed baseline, in either the
 * `--baseline <path>` or the `--baseline=<path>` form. */
const BASELINE_FLAG = /--baseline(?:=|\s+)(\S+)/g;

/** The baseline paths the `scripts/cpd.ts` tasks name, sorted and unique. A
 * scan whose baseline sits outside the names the ratchet reads can raise that
 * baseline unseen, so the check holds the two lists together. */
export const baselinePathsNamed: TaskReader = (tasks) =>
  sortStrings(
    unique(
      flatMap((command: string) =>
        Array.from(command.matchAll(BASELINE_FLAG), (match) =>
          requireValue(
            match[1],
            `A cpd task names --baseline with no path: ${match[0]}`,
          ),
        ),
      )(scanCommands(tasks)),
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
      fix: "keep the baseline in cfg/, named .jscpd.<scan>-baseline.json",
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

/** How many clones `head` holds under fingerprints the base does not hold. */
const addedClones = (
  head: FingerprintCounts,
  base: FingerprintCounts,
): number =>
  Object.entries(head).reduce(
    (total, [fingerprint, count]) =>
      base[fingerprint] === undefined ? total + count : total,
    0,
  );

/** How many clones one baseline file holds that its merge base copy does not
 * hold. The ratchet scans for re-pairs only when this is above zero. */
export const addedCloneCount = (
  path: string,
  headText: string,
  baseText: string,
): number =>
  addedClones(
    fingerprintCounts(path, headText),
    fingerprintCounts(path, baseText),
  );

/** The finding lines for one baseline file's clones above the base's counts,
 * in fingerprint order. A fingerprint the base does not hold is absent from
 * the scan's record, so it counts as zero accepted clones there, and any
 * count above zero is a rise. The added clones pass together when the scan
 * finds at least that many re-pairs. */
const risenFindings = (
  path: string,
  head: FingerprintCounts,
  base: FingerprintCounts,
  rePairs: number,
): string[] => {
  const addedPass = addedClones(head, base) <= rePairs;
  const rises = Object.entries(head).filter(
    ([fingerprint, count]) =>
      count > (base[fingerprint] ?? 0) &&
      !(addedPass && base[fingerprint] === undefined),
  );
  return sort((left: [string, number], right: [string, number]) =>
    left[0].localeCompare(right[0]),
  )(rises).map(([fingerprint, count]) => {
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
};

/**
 * One baseline file's rises against the merge base, in fingerprint order.
 * `baseText` is undefined when the merge base holds no such file: a new
 * baseline accepts clones that main never accepted, so it fails unless it
 * holds none. `rePairs` is the count of re-paired clones the scan found.
 */
export const riseFindings = (
  path: string,
  headText: string,
  baseText: string | undefined,
  rePairs: number,
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
  const base = fingerprintCounts(path, baseText);
  return risenFindings(path, head, base, rePairs);
};
