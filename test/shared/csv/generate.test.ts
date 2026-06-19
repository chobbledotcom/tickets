import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toCsv } from "#shared/csv/generate.ts";

describe("toCsv", () => {
  const keys = ["Name", "Age"] as const;

  test("emits just the header when there are no rows", () => {
    expect(toCsv([], keys)).toBe("Name,Age");
  });

  test("emits one line per row in column order", () => {
    const csv = toCsv(
      [
        { Age: "30", Name: "Alice" },
        { Age: "25", Name: "Bob" },
      ],
      keys,
    );
    expect(csv).toBe("Name,Age\nAlice,30\nBob,25");
  });

  test("escapes values and headers containing commas or quotes", () => {
    const csv = toCsv([{ "A,B": 'a "x"', C: "plain" }], ["A,B", "C"]);
    expect(csv).toBe('"A,B",C\n"a ""x""",plain');
  });

  test("throws when given no columns", () => {
    expect(() => toCsv([{ a: "1" }], [])).toThrow(
      "at least one column key is required",
    );
  });

  test("throws on duplicate column keys", () => {
    expect(() => toCsv([], ["Name", "Name"])).toThrow("duplicate column keys");
  });

  test("throws when a row has more keys than columns", () => {
    expect(() => toCsv([{ Age: "1", Extra: "x", Name: "A" }], keys)).toThrow(
      "do not match columns",
    );
  });

  test("throws when a row is missing a column it should have", () => {
    // Same key count as the column list, but "Age" is replaced by "Nope", so
    // the per-column presence check is what catches the mismatch. The row type
    // is widened so the deliberately-mismatched keys still type-check.
    const rows: Record<string, string>[] = [{ Name: "A", Nope: "x" }];
    expect(() => toCsv(rows, keys)).toThrow('row is missing column "Age"');
  });
});
