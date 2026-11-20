import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  placeCount,
  readCounts,
  rises,
  updatedCounts,
  updateSummary,
} from "#scripts/jscpd/counts.ts";
import type { ClonePair, Place } from "#scripts/jscpd/worst.ts";

const place = (file: string, start: number, end: number): Place => ({
  end,
  file,
  start,
});

const pair = (first: Place, second: Place): ClonePair => ({
  first,
  second,
  tokens: 40,
});

describe("placeCount", () => {
  test("counts each place once, however many pairs link it", () => {
    expect(
      placeCount([
        pair(place("a.ts", 1, 4), place("b.ts", 1, 4)),
        pair(place("a.ts", 1, 4), place("c.ts", 9, 12)),
      ]),
    ).toBe(3);
  });

  test("holds no place for a scan with no clone", () => {
    expect(placeCount([])).toBe(0);
  });

  test("keeps two windows of one file apart", () => {
    expect(placeCount([pair(place("a.ts", 1, 4), place("a.ts", 5, 8))])).toBe(
      2,
    );
  });
});

describe("readCounts", () => {
  test("reads a count for each scan", () => {
    expect(readCounts("cfg/cpd-counts.json", '{"main": 3, "test": 5}')).toEqual(
      { main: 3, test: 5 },
    );
  });

  test("refuses text that is not JSON, naming the file", () => {
    expect(() => readCounts("cfg/cpd-counts.json", "{,}")).toThrow(
      "The cpd counts file cfg/cpd-counts.json does not hold JSON.",
    );
  });

  test("refuses a count that is not a whole number", () => {
    expect(() => readCounts("cfg/cpd-counts.json", '{"main": 1.5}')).toThrow(
      "The cpd counts file cfg/cpd-counts.json does not hold counts:",
    );
  });

  test("refuses text that is not a record of counts", () => {
    expect(() => readCounts("cfg/cpd-counts.json", "null")).toThrow(
      "The cpd counts file cfg/cpd-counts.json does not hold counts:",
    );
  });
});

describe("updatedCounts", () => {
  test("adds a count and keeps the scan names in order", () => {
    expect(updatedCounts({ test: 5 }, "main", 3)).toEqual({ main: 3, test: 5 });
  });

  test("replaces the count of a scan the file holds", () => {
    expect(updatedCounts({ main: 3, test: 5 }, "main", 2)).toEqual({
      main: 2,
      test: 5,
    });
  });
});

describe("rises", () => {
  test("names a scan the base does not hold and one above it", () => {
    expect(rises({ main: 3, test: 2 }, { test: 1 })).toEqual([
      ["main", 3],
      ["test", 2],
    ]);
  });

  test("passes a scan the head lowered and one it dropped", () => {
    expect(rises({ main: 1 }, { main: 2, test: 1 })).toEqual([]);
  });

  test("reports the scans in name order", () => {
    expect(rises({ main: 1, test: 1 }, {}).map(([scan]) => scan)).toEqual([
      "main",
      "test",
    ]);
  });
});

describe("updateSummary", () => {
  test("reports the places a scan gave up", () => {
    expect(updateSummary("cfg/cpd-counts.json", "main", 1340, 1348)).toBe(
      "cfg/cpd-counts.json updated: main records 1340 place(s), 8 fewer than 1348",
    );
  });

  test("reports a count that did not move", () => {
    expect(updateSummary("cfg/cpd-counts.json", "main", 1348, 1348)).toBe(
      "cfg/cpd-counts.json updated: main records 1348 place(s), unchanged",
    );
  });

  test("reports a first count", () => {
    expect(updateSummary("cfg/cpd-counts.json", "main", 1348, undefined)).toBe(
      "cfg/cpd-counts.json updated: main records 1348 place(s)",
    );
  });
});
