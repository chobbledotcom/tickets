import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BASELINE_VERSION,
  baselineText,
  countDifference,
  placeLines,
  readBaseline,
  rises,
  scanFingerprints,
  snippetContent,
  snippetFingerprint,
  totalCount,
  updateSummary,
  versionMismatch,
} from "#scripts/jscpd/baseline.ts";
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

const snippetOf = (place: Place): string => {
  if (place.file === "a.ts") return "const a = 1;\n\nreturn a;\n";
  if (place.file === "b.ts") return "const a=1;\nreturn a;";
  return "const c = 3;\nreturn c;";
};

describe("snippetContent", () => {
  test("removes every run of whitespace, including blank lines", () => {
    expect(snippetContent("const a = 1;\n\n  return a; \r\n")).toBe(
      "consta=1;returna;",
    );
  });

  test("keeps every other character, so different code stays different", () => {
    expect(snippetContent("a + b")).toBe("a+b");
    expect(snippetContent("a - b")).toBe("a-b");
  });
});

describe("snippetFingerprint", () => {
  test("is the same for snippets that differ only in whitespace", async () => {
    expect(await snippetFingerprint("const a = 1;\n\nreturn a;\n")).toBe(
      await snippetFingerprint("const a=1;\nreturn a;"),
    );
  });

  test("is a 16-character lowercase hex name", async () => {
    expect(await snippetFingerprint("const a = 1;")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("differs for snippets that differ in code", async () => {
    expect(await snippetFingerprint("const a = 1;")).not.toBe(
      await snippetFingerprint("const a = 2;"),
    );
  });
});

describe("placeLines", () => {
  test("reads the place's lines, both ends included", () => {
    expect(
      placeLines(["one", "two", "three", "four"], place("a.ts", 2, 3)),
    ).toBe("two\nthree");
  });
});

describe("scanFingerprints", () => {
  test("counts each place once, by its content", async () => {
    const scan = await scanFingerprints(
      [
        pair(place("a.ts", 1, 2), place("b.ts", 1, 2)),
        pair(place("a.ts", 1, 2), place("b.ts", 1, 2)),
      ],
      snippetOf,
    );
    expect(Object.values(scan.counts)).toEqual([2]);
    expect(Object.values(scan.places)[0]).toEqual([
      place("a.ts", 1, 2),
      place("b.ts", 1, 2),
    ]);
  });

  test("keeps one count per distinct content", async () => {
    const scan = await scanFingerprints(
      [pair(place("a.ts", 1, 2), place("c.ts", 4, 5))],
      snippetOf,
    );
    expect(Object.values(scan.counts).sort()).toEqual([1, 1]);
    expect(Object.keys(scan.places)).toHaveLength(2);
  });

  test("holds no fingerprint for a scan with no clone", async () => {
    expect(await scanFingerprints([], snippetOf)).toEqual({
      counts: {},
      places: {},
    });
  });
});

describe("baselineText", () => {
  test("writes the current version with fingerprints in name order", () => {
    const text = baselineText({ aaa: 1, bbb: 2 });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      fingerprints: { aaa: 1, bbb: 2 },
      version: BASELINE_VERSION,
    });
    expect(text.indexOf("aaa")).toBeLessThan(text.indexOf("bbb"));
  });
});

describe("readBaseline", () => {
  test("reads the version and the counts", () => {
    expect(
      readBaseline("base.json", '{"version": 2, "fingerprints": {"aaa": 3}}'),
    ).toEqual({ counts: { aaa: 3 }, version: 2 });
  });

  test("reads an older version, so a merge base copy stays comparable", () => {
    expect(
      readBaseline("base.json", '{"version": 1, "fingerprints": {}}'),
    ).toEqual({ counts: {}, version: 1 });
  });

  test("refuses text that is not JSON, naming the file", () => {
    expect(() => readBaseline("base.json", "{,}")).toThrow(
      "The jscpd baseline base.json does not hold JSON.",
    );
  });

  test("refuses text that is not a baseline, naming the file", () => {
    expect(() => readBaseline("base.json", '{"version": 2}')).toThrow(
      "The jscpd baseline base.json does not hold a baseline:",
    );
  });

  test("refuses a count that is not a whole number", () => {
    expect(() =>
      readBaseline("base.json", '{"version": 2, "fingerprints": {"a": 1.5}}'),
    ).toThrow("The jscpd baseline base.json does not hold a baseline:");
  });
});

describe("rises", () => {
  test("names a count the base does not hold and one above it", () => {
    expect(rises({ aaa: 1, bbb: 3 }, { bbb: 2, ccc: 1 })).toEqual([
      ["aaa", 1],
      ["bbb", 3],
    ]);
  });

  test("passes a clone the head dropped and one it lowered", () => {
    expect(rises({ aaa: 1 }, { aaa: 2, bbb: 1 })).toEqual([]);
  });

  test("reports fingerprints in name order", () => {
    expect(rises({ aaa: 1, zzz: 1 }, {}).map(([name]) => name)).toEqual([
      "aaa",
      "zzz",
    ]);
  });
});

describe("countDifference", () => {
  test("counts the places one baseline adds to and removes from another", () => {
    expect(countDifference({ aaa: 2, bbb: 1 }, { aaa: 1, ccc: 3 })).toEqual({
      added: 2,
      removed: 3,
    });
  });

  test("counts nothing between two equal baselines", () => {
    expect(countDifference({ aaa: 1 }, { aaa: 1 })).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe("totalCount", () => {
  test("adds every count", () => {
    expect(totalCount({ aaa: 2, bbb: 3 })).toBe(5);
    expect(totalCount({})).toBe(0);
  });
});

describe("a written baseline", () => {
  test("reads back as the counts it wrote", () => {
    const counts = { "0123456789abcdef": 3, fedcba9876543210: 1 };
    expect(readBaseline("base.json", baselineText(counts))).toEqual({
      counts,
      version: BASELINE_VERSION,
    });
  });

  test("holds nothing new for the scan that wrote it", async () => {
    const scan = await scanFingerprints(
      [pair(place("a.ts", 1, 2), place("b.ts", 1, 2))],
      snippetOf,
    );
    const written = readBaseline("base.json", baselineText(scan.counts));
    expect(rises(scan.counts, written.counts)).toEqual([]);
  });

  test("counts a snippet the same after a shift moves it down the file", async () => {
    const snippet = ["const a = 1;", "return a;"];
    const shiftedLines = ["// one", "// two", ...snippet];
    const first = await scanFingerprints(
      [pair(place("a.ts", 1, 2), place("b.ts", 1, 2))],
      (target: Place) => placeLines(snippet, target),
    );
    const shifted = await scanFingerprints(
      [pair(place("a.ts", 3, 4), place("b.ts", 3, 4))],
      (target: Place) => placeLines(shiftedLines, target),
    );
    expect(shifted.counts).toEqual(first.counts);
    expect(Object.values(shifted.places)).toEqual([
      [place("a.ts", 3, 4), place("b.ts", 3, 4)],
    ]);
  });
});

describe("versionMismatch", () => {
  test("says nothing about a baseline this tree writes", () => {
    expect(versionMismatch({ counts: {}, version: BASELINE_VERSION })).toBe(
      undefined,
    );
  });

  test("names both versions when the baseline holds another one", () => {
    expect(versionMismatch({ counts: {}, version: BASELINE_VERSION - 1 })).toBe(
      "holds fingerprint version 1, but this tree writes version 2",
    );
  });
});

describe("updateSummary", () => {
  test("reports the place counts one baseline adds and removes", () => {
    expect(
      updateSummary(
        "cfg/base.json",
        { aaa: 2 },
        {
          counts: { aaa: 1, ccc: 3 },
          version: BASELINE_VERSION,
        },
      ),
    ).toBe("cfg/base.json updated: 1 place(s) added, 3 removed (2 total)");
  });

  test("reports what a first baseline records", () => {
    expect(updateSummary("cfg/base.json", { aaa: 2 }, undefined)).toBe(
      "cfg/base.json updated: fingerprint version 2 records 2 place(s)",
    );
  });

  test("reports what a rewrite of another version records", () => {
    expect(
      updateSummary(
        "cfg/base.json",
        { aaa: 2 },
        {
          counts: { ddd: 9 },
          version: BASELINE_VERSION - 1,
        },
      ),
    ).toBe("cfg/base.json updated: fingerprint version 2 records 2 place(s)");
  });
});
