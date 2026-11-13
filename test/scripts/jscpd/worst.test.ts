import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ClonePair,
  describeWorstFamily,
  type Place,
  rankCloneFamilies,
  readClonePairs,
} from "#scripts/jscpd/worst.ts";

/** A place written as `file:start-end`. */
const place = (spec: string): Place => {
  const match = /^(.+):(\d+)-(\d+)$/.exec(spec);
  if (match === null) throw new Error(`Not a place: ${spec}`);
  const [, file = "", start = "", end = ""] = match;
  return { end: Number(end), file, start: Number(start) };
};

const link = (first: string, second: string, tokens = 30): ClonePair => ({
  first: place(first),
  second: place(second),
  tokens,
});

const spell = ({ end, file, start }: Place): string =>
  `${file}:${start}-${end}`;

/** Each family as its places and its tokens, the worst first. */
const ranked = (...pairs: ClonePair[]): [string[], number][] =>
  rankCloneFamilies(pairs).map(({ places, tokens }) => [
    places.map(spell),
    tokens,
  ]);

const reportOf = (duplicates: unknown[]): unknown => ({
  duplicates,
  statistics: {},
});

describe("readClonePairs", () => {
  test("reads each duplicate's two places and its token count", () => {
    const report = reportOf([
      {
        firstFile: { end: 9, name: "/r/a.ts", start: 3, startLoc: {} },
        format: "typescript",
        secondFile: { end: 14, name: "/r/b.ts", start: 8 },
        tokens: 41,
      },
    ]);
    expect(readClonePairs(report)).toEqual([
      link("/r/a.ts:3-9", "/r/b.ts:8-14", 41),
    ]);
  });

  test("fails loudly on a duplicate without a token count", () => {
    const report = reportOf([
      {
        firstFile: { end: 9, name: "a.ts", start: 3 },
        secondFile: { end: 14, name: "b.ts", start: 8 },
      },
    ]);
    expect(() => readClonePairs(report)).toThrow("tokens");
  });
});

describe("rankCloneFamilies", () => {
  test("gives no family for a report without duplicates", () => {
    expect(ranked()).toEqual([]);
  });

  const familyCases: {
    families: [string[], number][];
    links: ClonePair[];
    name: string;
  }[] = [
    {
      families: [[["a.ts:1-5", "b.ts:1-5", "c.ts:1-5"], 32]],
      links: [link("a.ts:1-5", "b.ts:1-5"), link("b.ts:1-5", "c.ts:1-5", 32)],
      name: "joins pairs that share a place, and keeps the most tokens",
    },
    {
      families: [
        [["a.ts:1-5", "b.ts:1-5", "c.ts:1-5", "d.ts:1-5", "e.ts:1-5"], 30],
      ],
      links: [
        link("a.ts:1-5", "b.ts:1-5"),
        link("c.ts:1-5", "d.ts:1-5"),
        link("b.ts:1-5", "d.ts:1-5"),
        link("a.ts:1-5", "e.ts:1-5"),
      ],
      name: "follows a chain of links when two families meet",
    },
    {
      families: [[["a.ts:10-25", "a.ts:26-30", "b.ts:1-9"], 30]],
      links: [
        link("a.ts:10-20", "b.ts:1-9"),
        link("b.ts:1-9", "a.ts:15-25"),
        link("a.ts:15-25", "a.ts:26-30"),
      ],
      name: "counts overlapping windows in one file as one place",
    },
    {
      families: [[["a.ts:10-40", "b.ts:1-9"], 30]],
      links: [link("a.ts:10-40", "b.ts:1-9"), link("b.ts:1-9", "a.ts:12-20")],
      name: "keeps a window inside an earlier one at the earlier end",
    },
  ];

  for (const { families, links, name } of familyCases) {
    test(name, () => {
      expect(ranked(...links)).toEqual(families);
    });
  }

  test("puts the most places first, then the most tokens", () => {
    expect(
      ranked(
        link("big.ts:1-9", "big2.ts:1-9", 90),
        link("x.ts:1-2", "y.ts:1-2"),
        link("y.ts:1-2", "z.ts:1-2"),
        link("c.ts:1-9", "d.ts:1-9", 95),
      ).map(([places, tokens]) => [places.length, tokens]),
    ).toEqual([
      [3, 30],
      [2, 95],
      [2, 90],
    ]);
  });
});

describe("describeWorstFamily", () => {
  test("says when a scan finds no duplication", () => {
    expect(describeWorstFamily("cfg/jscpd.json", [], "/r")).toEqual([
      "cfg/jscpd.json: no duplication found.",
    ]);
  });

  test("names the worst family and each place under the root", () => {
    const families = rankCloneFamilies([
      link("/r/src/a.ts:3-9", "/elsewhere/b.ts:8-14", 41),
      link("/x.ts:1-2", "/y.ts:1-2", 20),
    ]);
    expect(describeWorstFamily("cfg/jscpd.json", families, "/r")).toEqual([
      "cfg/jscpd.json: the worst duplication appears in 2 places, with 41 " +
        "tokens.",
      "  /elsewhere/b.ts:8-14",
      "  src/a.ts:3-9",
    ]);
  });

  test("shows ten places and counts the rest", () => {
    const pairs = Array.from({ length: 11 }, (_, index) =>
      link("/r/hub.ts:1-5", `/r/f${index + 10}.ts:1-5`),
    );
    const lines = describeWorstFamily("scan", rankCloneFamilies(pairs), "/r");
    expect(lines).toEqual([
      "scan: the worst duplication appears in 12 places, with 30 tokens.",
      ...Array.from({ length: 10 }, (_, index) => `  f${index + 10}.ts:1-5`),
      "  and 2 more places.",
    ]);
  });
});
