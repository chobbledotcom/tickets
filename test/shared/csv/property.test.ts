// Property tests for the shared CSV generator. The properties assert the
// documented contract against generated cells: an RFC 4180 round trip whose
// only deviation is the documented formula-neutralizer, and a row structure
// no cell content can break. fast-check runs each property with a fixed seed
// and run count, so every run generates the same cases.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import { type Column, CSV } from "#shared/csv/index.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

/** The documented OWASP formula-starter set the generator neutralizes. */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

/** One parser's mutable position: the current cell, row, and quoting state. */
type ParserState = {
  cell: string;
  index: number;
  inQuotes: boolean;
  row: string[];
  rows: string[][];
};

/** Read one character inside a quoted field: a doubled quote is data, a
 * single quote closes the field. */
const readQuoted = (text: string, state: ParserState): void => {
  const char = text[state.index]!;
  if (char === '"' && text[state.index + 1] === '"') {
    state.cell += '"';
    state.index += 2;
    return;
  }
  if (char === '"') {
    state.inQuotes = false;
    state.index += 1;
    return;
  }
  state.cell += char;
  state.index += 1;
};

/** Read one unquoted character: a comma ends the cell, a newline ends the
 * row, a quote opens a quoted field, anything else is cell data. */
const readUnquoted = (text: string, state: ParserState): void => {
  const char = text[state.index]!;
  if (char === ",") {
    state.row.push(state.cell);
    state.cell = "";
    state.index += 1;
    return;
  }
  if (char === "\n") {
    state.row.push(state.cell);
    state.rows.push(state.row);
    state.row = [];
    state.cell = "";
    state.index += 1;
    return;
  }
  if (char === '"') {
    state.inQuotes = true;
    state.index += 1;
    return;
  }
  state.cell += char;
  state.index += 1;
};

/** A reference RFC 4180 parser: quoted fields may hold commas, doubled
 * quotes, and newlines; every other character is cell data. Malformed text —
 * a quote that never closes — throws, so a generator bug cannot hide behind
 * a lenient read. */
const parseCsv = (text: string): string[][] => {
  const state: ParserState = {
    cell: "",
    index: 0,
    inQuotes: false,
    row: [],
    rows: [],
  };
  while (state.index < text.length) {
    if (state.inQuotes) {
      readQuoted(text, state);
    } else {
      readUnquoted(text, state);
    }
  }
  if (state.inQuotes) {
    throw new Error(`Unterminated quoted field in: ${text}`);
  }
  state.row.push(state.cell);
  state.rows.push(state.row);
  return state.rows;
};

/** Generate one CSV row whose every cell is the generated string at that
 * position, and return the generated text. */
const generateRow = (cells: string[]): string => {
  const columns: Column<{ cells: string[] }>[] = cells.map((_, index) => ({
    header: `c${index}`,
    value: (row: { cells: string[] }) => row.cells[index]!,
  }));
  return CSV.generate([{ cells }], columns);
};

/** The header row the same generate call emits: `c0,c1,…`, one name per
 * position. */
const headerOf = (cells: string[]): string[] =>
  cells.map((_, index) => `c${index}`);

describe("CSV.generate properties", () => {
  test("parses back to the cells, or to their tab-neutralized form", () => {
    const arbitraryCells = fc.array(
      fc.string({ maxLength: 40, minLength: 0 }),
      { maxLength: 6, minLength: 1 },
    );
    fc.assert(
      fc.property(arbitraryCells, (cells) => {
        const parsed = parseCsv(generateRow(cells));
        expect(parsed.length).toBe(2);
        expect(parsed[0]).toEqual(headerOf(cells));
        expect(parsed[1]).toEqual(
          cells.map((cell) => (FORMULA_START.test(cell) ? `\t${cell}` : cell)),
        );
      }),
      seedArgs,
    );
  });

  test("keeps one line per item and one field per column", () => {
    const arbitraryRows = fc.array(
      fc.array(fc.string({ maxLength: 40, minLength: 0 }), {
        maxLength: 6,
        minLength: 1,
      }),
      { maxLength: 8, minLength: 0 },
    );
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        // The generator requires at least one column, so the column count
        // comes from the first row and never falls below one; shorter rows
        // read the missing trailing cells as empty.
        const columnCount = Math.max(1, rows[0]?.length ?? 0);
        const columns: Column<{ cells: string[] }>[] = Array.from(
          { length: columnCount },
          (_, index) => ({
            header: `c${index}`,
            value: (row: { cells: string[] }) => row.cells[index] ?? "",
          }),
        );
        const csv = CSV.generate(
          rows.map((cells) => ({ cells })),
          columns,
        );
        const parsed = parseCsv(csv);
        expect(parsed.length).toBe(rows.length + 1);
        for (const row of parsed) {
          expect(row.length).toBe(columnCount);
        }
      }),
      seedArgs,
    );
  });
});
