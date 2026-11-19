/**
 * The clone counts: one number for each scan, the number of duplicated places
 * that the scan reports. A place counts once, however many clone pairs link
 * it, so a line that moves, a blank line, a file rename, and a new partner for
 * a recorded place all keep the count. The number falls only when a merge
 * removes duplicated code.
 *
 * The scans keep their counts in `cfg/cpd-counts.json`, and each count only
 * falls. See "Code Duplication" in AGENTS.md.
 */

import * as v from "valibot";
import { sort } from "#fp";
import { parseJsonWith } from "#scripts/read-json.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { type ClonePair, placeKey } from "./worst.ts";

/** The file that holds one place count for each scan. */
export const COUNTS_PATH = "cfg/cpd-counts.json";

/** One duplicated-place count for each scan, keyed by the scan's name. */
export type ScanCounts = Record<string, number>;

/** A counts file's shape: a whole number of places for each scan. */
const COUNTS_SCHEMA = v.record(v.string(), integerAtLeast(0));

/** How many duplicated places one scan reports. A place counts once, however
 * many clone pairs link it. */
export const placeCount = (pairs: readonly ClonePair[]): number =>
  new Set(
    pairs.flatMap(({ first, second }) => [placeKey(first), placeKey(second)]),
  ).size;

/** One counts file's records, in scan-name order. */
const namedEntries = (counts: ScanCounts): [string, number][] =>
  sort(([left]: [string, number], [right]: [string, number]) =>
    left.localeCompare(right),
  )(Object.entries(counts));

/** One counts file's contents, read from its text. Text that is not a counts
 * file fails loudly and names the file. */
export const readCounts = (path: string, text: string): ScanCounts => {
  const parsed = v.safeParse(
    COUNTS_SCHEMA,
    parseJsonWith(() => {
      throw new Error(`The cpd counts file ${path} does not hold JSON.`);
    })(text),
  );
  if (!parsed.success) {
    throw new Error(
      `The cpd counts file ${path} does not hold counts: ` +
        v.summarize(parsed.issues),
    );
  }
  return parsed.output;
};

/** `counts` with the current count for `scan`, in scan-name order. */
export const updatedCounts = (
  counts: ScanCounts,
  scan: string,
  count: number,
): ScanCounts => Object.fromEntries(namedEntries({ ...counts, [scan]: count }));

/** The scans whose count `head` holds above `base`, in scan-name order. A scan
 * that `base` does not hold counts as zero there. */
export const rises = (head: ScanCounts, base: ScanCounts): [string, number][] =>
  namedEntries(head).filter(([scan, count]) => count > (base[scan] ?? 0));

/** The summary that `--update` prints: the count the scan records now, and the
 * places it gave up against the count before. */
export const updateSummary = (
  path: string,
  scan: string,
  count: number,
  before: number | undefined,
): string => {
  const now = `${path} updated: ${scan} records ${count} place(s)`;
  if (before === undefined) return now;
  const givenUp = before - count;
  return givenUp === 0
    ? `${now}, unchanged`
    : `${now}, ${givenUp} fewer than ${before}`;
};
