/**
 * The clone baseline: one count per duplicated snippet, keyed by the snippet's
 * content, so a line that moves does not change it. jscpd hashes the raw
 * source text of a clone pair, and a blank line inside a duplicated block
 * changes that text. This module hashes the snippet with every run of
 * whitespace removed, and counts each place once, so neither a line shift nor
 * the partner jscpd pairs a place with changes the record.
 *
 * jscpd's baseline and this one differ in shape: `version` 2 names this
 * module, and the ratchet cannot compare counts of two versions.
 */

import * as v from "valibot";
import { sort } from "#fp";
import { parseJsonWith } from "#scripts/read-json.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import type { ClonePair, Place } from "./worst.ts";

/** The version of the baseline shape this tree writes. Version 1 held
 * jscpd's own raw-text fingerprints; version 2 holds whitespace-free content
 * fingerprints with one count per place. */
export const BASELINE_VERSION = 2;

/** How many hex characters of the digest name one snippet. */
const FINGERPRINT_LENGTH = 16;

/** One fingerprint's count: how many places hold that snippet. */
export type FingerprintCounts = Record<string, number>;

/** A baseline file's contents: its shape version and its counts. */
export interface Baseline {
  counts: FingerprintCounts;
  version: number;
}

/** A baseline file's shape. `version` stays a plain number so the ratchet can
 * read a copy that an older or newer tree wrote and say what it found. */
const BASELINE_SCHEMA = v.object({
  fingerprints: v.record(v.string(), integerAtLeast(0)),
  version: v.number(),
});

/** The content a fingerprint covers: the snippet with every run of whitespace
 * removed. A blank line, a re-indent, or a line ending therefore leaves the
 * fingerprint unchanged. */
export const snippetContent = (text: string): string =>
  text.replace(/\s+/g, "");

/** The fingerprint of one duplicated snippet. */
export const snippetFingerprint = async (text: string): Promise<string> =>
  (await sha256Hex(snippetContent(text))).slice(0, FINGERPRINT_LENGTH);

/** Where one snippet sits. Two reports of the same place share this key. */
const placeKey = ({ end, file, start }: Place): string =>
  `${file}:${start}-${end}`;

/** The lines one place covers, from the whole file's lines. The place's start
 * and end are 1-indexed and inclusive, as jscpd reports them. */
export const placeLines = (lines: readonly string[], place: Place): string =>
  lines.slice(place.start - 1, place.end).join("\n");

/** What the source text of one place is. */
export type SnippetReader = (place: Place) => string;

/** One scan's fingerprints: how many places hold each snippet, and the places
 * each fingerprint covers. */
export interface ScanFingerprints {
  counts: FingerprintCounts;
  places: Record<string, Place[]>;
}

/** The snippet counts of one scan. Each place counts once, so a family of
 * three copies counts three, not one for every pair that links the copies. */
export const scanFingerprints = async (
  pairs: readonly ClonePair[],
  readSnippet: SnippetReader,
): Promise<ScanFingerprints> => {
  const seen = new Map<string, Place>();
  for (const { first, second } of pairs) {
    for (const place of [first, second]) {
      const key = placeKey(place);
      if (!seen.has(key)) seen.set(key, place);
    }
  }
  const byFingerprint = new Map<string, Place[]>();
  for (const place of seen.values()) {
    const fingerprint = await snippetFingerprint(readSnippet(place));
    const list = byFingerprint.get(fingerprint);
    if (list === undefined) byFingerprint.set(fingerprint, [place]);
    else list.push(place);
  }
  const counts: FingerprintCounts = {};
  const places: Record<string, Place[]> = {};
  for (const [fingerprint, list] of byFingerprint) {
    counts[fingerprint] = list.length;
    places[fingerprint] = list;
  }
  return { counts, places };
};

/** A baseline file's text, with one fingerprint per line in fingerprint order
 * so a merge reads the same lines as the file it replaces. */
export const baselineText = (counts: FingerprintCounts): string => {
  const sorted = sort(([left]: [string, number], [right]: [string, number]) =>
    left.localeCompare(right),
  )(Object.entries(counts));
  return `${JSON.stringify(
    { fingerprints: Object.fromEntries(sorted), version: BASELINE_VERSION },
    null,
    2,
  )}\n`;
};

/** One baseline file's contents, read from its text. Text that is not a
 * baseline fails loudly and names the file. */
export const readBaseline = (path: string, text: string): Baseline => {
  const parsed = v.safeParse(
    BASELINE_SCHEMA,
    parseJsonWith(() => {
      throw new Error(`The jscpd baseline ${path} does not hold JSON.`);
    })(text),
  );
  if (!parsed.success) {
    throw new Error(
      `The jscpd baseline ${path} does not hold a baseline: ` +
        v.summarize(parsed.issues),
    );
  }
  return { counts: parsed.output.fingerprints, version: parsed.output.version };
};

/** What to say about a baseline that holds another fingerprint version, or
 * undefined when it holds this tree's. Two readers compare counts, the scan and
 * the ratchet, and counts of two versions name different things. */
export const versionMismatch = ({ version }: Baseline): string | undefined =>
  version === BASELINE_VERSION
    ? undefined
    : `holds fingerprint version ${version}, but this tree writes version ` +
      `${BASELINE_VERSION}`;

/** The fingerprints whose count `head` holds above `base`, in fingerprint
 * order. A fingerprint that `base` does not hold counts as zero there. */
export const rises = (
  head: FingerprintCounts,
  base: FingerprintCounts,
): [fingerprint: string, count: number][] =>
  sort(([left]: [string, number], [right]: [string, number]) =>
    left.localeCompare(right),
  )(
    Object.entries(head).filter(
      ([fingerprint, count]) => count > (base[fingerprint] ?? 0),
    ),
  );

/** How many place counts `head` adds to and removes from `base`, in the
 * summary that `--update` prints. */
export const countDifference = (
  head: FingerprintCounts,
  base: FingerprintCounts,
): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const [fingerprint, count] of Object.entries(head)) {
    added += Math.max(count - (base[fingerprint] ?? 0), 0);
  }
  for (const [fingerprint, count] of Object.entries(base)) {
    removed += Math.max(count - (head[fingerprint] ?? 0), 0);
  }
  return { added, removed };
};

/** The sum of every count in one baseline. */
export const totalCount = (counts: FingerprintCounts): number =>
  Object.values(counts).reduce((total, count) => total + count, 0);

/** The summary that `--update` prints. A baseline of another fingerprint
 * version holds counts this tree cannot compare, so a rewrite reports what it
 * now records instead of a difference. */
export const updateSummary = (
  path: string,
  counts: FingerprintCounts,
  before: Baseline | undefined,
): string => {
  const total = totalCount(counts);
  if (before === undefined || versionMismatch(before) !== undefined) {
    return (
      `${path} updated: fingerprint version ${BASELINE_VERSION} records ` +
      `${total} place(s)`
    );
  }
  const { added, removed } = countDifference(counts, before.counts);
  return (
    `${path} updated: ${added} place(s) added, ${removed} removed ` +
    `(${total} total)`
  );
};
