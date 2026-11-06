/**
 * Find the worst duplication in a jscpd report. jscpd reports pairs, so the
 * pairs that share a place join into one family: one piece of code and every
 * place it appears. The worst family appears in the most places, then holds
 * the most tokens.
 */

import * as v from "valibot";
import { groupToMap, map, pipe, reduce, sort } from "#fp";

const ReportPlaceSchema = v.object({
  end: v.number(),
  name: v.string(),
  start: v.number(),
});

const ReportSchema = v.object({
  duplicates: v.array(
    v.object({
      firstFile: ReportPlaceSchema,
      secondFile: ReportPlaceSchema,
      tokens: v.number(),
    }),
  ),
});

/** A line range in one file. */
export type Place = { end: number; file: string; start: number };

export type ClonePair = { first: Place; second: Place; tokens: number };

export type CloneFamily = { places: Place[]; tokens: number };

const toPlace = ({
  end,
  name,
  start,
}: v.InferOutput<typeof ReportPlaceSchema>): Place => ({
  end,
  file: name,
  start,
});

/** The clone pairs in a parsed jscpd JSON report. */
export const readClonePairs = (report: unknown): ClonePair[] =>
  v
    .parse(ReportSchema, report)
    .duplicates.map(({ firstFile, secondFile, tokens }) => ({
      first: toPlace(firstFile),
      second: toPlace(secondFile),
      tokens,
    }));

const placeKey = ({ end, file, start }: Place): string =>
  `${file}:${start}-${end}`;

/** Follows the links from a place to the place that leads its family. A place
 * with no link leads its own family. */
const familyLeader = (leaders: Map<string, string>, key: string): string => {
  let current = key;
  for (
    let next = leaders.get(current);
    next !== undefined;
    next = leaders.get(current)
  ) {
    current = next;
  }
  return current;
};

/** Puts both places of each pair in one family. */
const linkPairs = (pairs: ClonePair[]): Map<string, string> => {
  const leaders = new Map<string, string>();
  for (const { first, second } of pairs) {
    const firstLeader = familyLeader(leaders, placeKey(first));
    const secondLeader = familyLeader(leaders, placeKey(second));
    if (firstLeader !== secondLeader) leaders.set(firstLeader, secondLeader);
  }
  return leaders;
};

const byFileThenStart = (a: Place, b: Place): number =>
  a.file.localeCompare(b.file) || a.start - b.start;

/** Counts overlapping windows over one stretch of a file as one place. */
const joinOverlaps = (places: Place[]): Place[] =>
  pipe(
    sort(byFileThenStart),
    reduce((joined: Place[], place: Place) => {
      const last = joined.at(-1);
      if (last?.file === place.file && place.start <= last.end) {
        last.end = Math.max(last.end, place.end);
      } else {
        joined.push({ ...place });
      }
      return joined;
    }, []),
  )(places);

const familyOf = (pairs: ClonePair[]): CloneFamily => ({
  places: joinOverlaps(pairs.flatMap(({ first, second }) => [first, second])),
  tokens: Math.max(...pairs.map(({ tokens }) => tokens)),
});

const worseFirst = (a: CloneFamily, b: CloneFamily): number =>
  b.places.length - a.places.length || b.tokens - a.tokens;

/** Every clone family, the worst first. */
export const rankCloneFamilies = (pairs: ClonePair[]): CloneFamily[] => {
  const leaders = linkPairs(pairs);
  return pipe(
    groupToMap(
      (pair: ClonePair) => familyLeader(leaders, placeKey(pair.first)),
      (pair: ClonePair) => pair,
    ),
    (families: Map<string, ClonePair[]>) => [...families.values()],
    map(familyOf),
    sort(worseFirst),
  )(pairs);
};

const PLACES_SHOWN = 10;

const placeLine =
  (root: string) =>
  ({ end, file, start }: Place): string =>
    `  ${file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file}:${start}-${end}`;

/** The alert for the worst family of one scan. `root` is cut from the front
 * of each file path. */
export const describeWorstFamily = (
  scan: string,
  families: CloneFamily[],
  root: string,
): string[] => {
  const [worst] = families;
  if (worst === undefined) return [`${scan}: no duplication found.`];
  const hidden = worst.places.length - PLACES_SHOWN;
  return [
    `${scan}: the worst duplication appears in ${worst.places.length} places, with ${worst.tokens} tokens.`,
    ...worst.places.slice(0, PLACES_SHOWN).map(placeLine(root)),
    ...(hidden > 0 ? [`  and ${hidden} more places.`] : []),
  ];
};
