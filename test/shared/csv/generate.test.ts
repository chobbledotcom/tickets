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

  test("allows duplicate headers (e.g. two same-named questions)", () => {
    const csv = CSV.generate(
      [{ a: "1", b: "2" }],
      [
        { header: "Q", value: (r: { a: string; b: string }) => r.a },
        { header: "Q", value: (r: { a: string; b: string }) => r.b },
      ],
    );
    expect(csv).toBe("Q,Q\n1,2");
  });

  test("preserves empty cells while escaping every RFC 4180 special character", () => {
    const csv = CSV.generate(
      [
        { note: "", title: "plain" },
        { note: "line\rbreak", title: 'quoted, "value"' },
      ],
      [
        {
          header: "Title",
          value: (row: { note: string; title: string }) => row.title,
        },
        {
          header: "Note",
          value: (row: { note: string; title: string }) => row.note,
        },
      ],
    );

    expect(csv).toBe('Title,Note\nplain,\n"quoted, ""value""","line\rbreak"');
  });
});
