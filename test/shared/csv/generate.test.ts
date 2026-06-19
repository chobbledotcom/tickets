import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Column, CSV } from "#shared/csv/index.ts";

type Person = { name: string; age: number };
const columns: Column<Person>[] = [
  { header: "Name", value: (p) => p.name },
  { header: "Age", value: (p) => String(p.age) },
];

describe("CSV.generate", () => {
  test("emits just the header when there are no items", () => {
    expect(CSV.generate([], columns)).toBe("Name,Age");
  });

  test("emits one line per item, reading each cell via its column", () => {
    const csv = CSV.generate(
      [
        { age: 30, name: "Alice" },
        { age: 25, name: "Bob" },
      ],
      columns,
    );
    expect(csv).toBe("Name,Age\nAlice,30\nBob,25");
  });

  test("escapes headers and cells with commas, quotes or newlines", () => {
    const csv = CSV.generate(
      [{ value: 'a "x"\nb' }],
      [{ header: "A,B", value: (r: { value: string }) => r.value }],
    );
    expect(csv).toBe('"A,B"\n"a ""x""\nb"');
  });

  test("throws when given no columns", () => {
    expect(() => CSV.generate([{ a: 1 }], [])).toThrow(
      "at least one column is required",
    );
  });

  test("throws on duplicate column headers", () => {
    expect(() =>
      CSV.generate(
        [],
        [
          { header: "X", value: () => "1" },
          { header: "X", value: () => "2" },
        ],
      ),
    ).toThrow("duplicate column headers");
  });
});
