import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  endsWithAny,
  includesAny,
  sortedByString,
  startsWithAny,
} from "#fp-strings";

describe("sortedByString", () => {
  type Row = { name: string };

  test("sorts by the string field in locale order without changing the input", () => {
    const rows: Row[] = [{ name: "b" }, { name: "a" }, { name: "c" }];
    expect(sortedByString((row: Row) => row.name)(rows)).toEqual([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    expect(rows).toEqual([{ name: "b" }, { name: "a" }, { name: "c" }]);
  });

  test("puts the largest or newest field first with desc", () => {
    const rows = [{ at: "2026-01-01" }, { at: "2026-03-01" }];
    expect(
      sortedByString((row: { at: string }) => row.at, "desc")(rows),
    ).toEqual([{ at: "2026-03-01" }, { at: "2026-01-01" }]);
  });
});

describe("startsWithAny", () => {
  test("answers true when the text begins with any prefix", () => {
    expect(
      startsWithAny(["config file ", "Using config from "])(
        "Using config from /tmp/x",
      ),
    ).toBe(true);
    expect(startsWithAny(["config file "])("config file .opencode.json")).toBe(
      true,
    );
  });

  test("answers false when no prefix matches", () => {
    expect(startsWithAny(["a", "b"])("cab")).toBe(false);
    expect(startsWithAny(["a"])("")).toBe(false);
  });
});

describe("endsWithAny", () => {
  test("answers true when the text ends with any suffix", () => {
    expect(endsWithAny([".ts", ".tsx"])("widget.tsx")).toBe(true);
    expect(endsWithAny([".test.ts"])("widget.test.ts")).toBe(true);
  });

  test("answers false when no suffix matches", () => {
    expect(endsWithAny([".ts", ".tsx"])("style.css")).toBe(false);
    // A suffix must match the whole ending, not an inside run.
    expect(endsWithAny(["get.test"])("widget.test.ts")).toBe(false);
  });
});

describe("includesAny", () => {
  test("answers true when the text holds any piece", () => {
    expect(includesAny(["{", "'"])("Hello {name}")).toBe(true);
    expect(includesAny(["{", "'"])("it''s")).toBe(true);
  });

  test("answers false when the text holds no piece", () => {
    expect(includesAny(["{", "'"])("plain words")).toBe(false);
    expect(includesAny([])("anything")).toBe(false);
  });
});
