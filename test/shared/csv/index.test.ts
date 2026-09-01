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

describe("CSV.generate formula safety", () => {
  const valueColumn: Column<{ value: string }>[] = [
    { header: "Value", value: (row) => row.value },
  ];

  test("puts a tab in front of every character that can start a formula", () => {
    const inertCells: [string, string][] = [
      ["=SUM(A1:A2)", "\t=SUM(A1:A2)"],
      ["+44 20 7946", "\t+44 20 7946"],
      ["-Maria", "\t-Maria"],
      ["@handle", "\t@handle"],
      ["\tTabbed start", "\t\tTabbed start"],
      ["＝SUM(A1:A2)", "\t＝SUM(A1:A2)"],
      ["＋44 20 7946", "\t＋44 20 7946"],
      ["－Maria", "\t－Maria"],
      ["＠handle", "\t＠handle"],
    ];
    for (const [formulaText, inertCell] of inertCells) {
      expect(CSV.generate([{ value: formulaText }], valueColumn)).toBe(
        `Value\n${inertCell}`,
      );
    }
  });

  test("puts a tab in front of a carriage return that starts a cell", () => {
    // The CR also trips RFC 4180 quoting, so both guards apply to it.
    expect(CSV.generate([{ value: "\rcmd" }], valueColumn)).toBe(
      'Value\n"\t\rcmd"',
    );
  });

  test("puts a tab in front of a line feed that starts a cell", () => {
    // Same shape as the CR case: LF trips RFC 4180 quoting too.
    expect(CSV.generate([{ value: "\n=cmd" }], valueColumn)).toBe(
      'Value\n"\t\n=cmd"',
    );
  });

  test("leaves cells that cannot start a formula alone", () => {
    const csv = CSV.generate(
      [{ value: "a=b" }, { value: "1+1" }, { value: "Bob" }, { value: "" }],
      valueColumn,
    );
    expect(csv).toBe("Value\na=b\n1+1\nBob\n");
  });

  test("stops a formula and quotes the cell when it also has a comma", () => {
    expect(CSV.generate([{ value: "=a,b" }], valueColumn)).toBe(
      'Value\n"\t=a,b"',
    );
  });

  test("puts a tab in front of a formula character that starts a header", () => {
    expect(CSV.generate([], [{ header: "=Total", value: () => "" }])).toBe(
      "\t=Total",
    );
  });
});
