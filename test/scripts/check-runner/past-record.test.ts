import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findingsPastRecord,
  type RecordWords,
  updateMode,
} from "#scripts/check-runner.ts";

const words: RecordWords = {
  clean: "holds nothing",
  fewer: (count, recorded) =>
    `holds ${count}, fewer than the recorded ${recorded}`,
  registry: "reg.json",
  updateCommand: "deno task check:x --update",
};

const past = (item: { line: number }) => ({
  fix: "fix it",
  line: item.line,
  problem: "past the record",
  rule: "past",
});

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ line: index + 10 }));

/** The findings for a file that holds `count` items and records `recorded`
 * (null for no entry). */
const findings = (count: number, recorded: number | null) =>
  findingsPastRecord(
    "f.ts",
    items(count),
    recorded === null ? {} : { "f.ts": recorded },
    words,
    past,
  );

/** One finding of the shape that the helper reports. */
const finding = (rule: string, fix: string, problem: string) => ({
  fix,
  line: 1,
  problem,
  rule,
});

/** Each case: how many items the file holds, what it records (null for no
 * entry), and the lines of the findings that the helper reports. */
const LINE_CASES: Record<string, [number, number | null, number[]]> = {
  "fails every item of a file that has no entry": [1, null, [10]],
  "fails the items past the recorded count, in order": [3, 1, [11, 12]],
  "passes a file that holds its recorded count": [2, 2, []],
  "says nothing about an empty file with no entry": [0, null, []],
};

describe("findingsPastRecord", () => {
  for (const [name, [count, recorded, lines]] of Object.entries(LINE_CASES)) {
    test(name, () => {
      expect(findings(count, recorded).map(({ line }) => line)).toEqual(lines);
    });
  }

  test("asks for the entry of an empty file to go", () => {
    expect(findings(0, 2)).toEqual([
      finding("stale-entry", "delete the entry in reg.json", "holds nothing"),
    ]);
  });

  test("asks for the record when the count has fallen", () => {
    expect(findings(1, 3)).toEqual([
      finding(
        "improved",
        "run `deno task check:x --update` to record the count",
        "holds 1, fewer than the recorded 3",
      ),
    ]);
  });
});

describe("updateMode", () => {
  test("refuses the retired --seed flag and says what to do instead", () => {
    expect(() => updateMode(["--seed"])).toThrow(
      "The --seed flag is gone. A registry only falls. Use --update after a fix, " +
        "or change the registry in a reviewed commit.",
    );
  });

  test("reads --update", () => {
    expect(updateMode(["--update"])).toEqual({ update: true });
    expect(updateMode([])).toEqual({ update: false });
  });
});
