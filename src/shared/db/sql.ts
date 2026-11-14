// effects: pure
/**
 * The one way to write SQL: the `sql` tag.
 *
 * Text inside the template is SQL. A value put into the template is never
 * text. It becomes a bound argument at the place it is written, so a value and
 * its placeholder cannot fall out of step. A statement put into another
 * statement brings its own values with it.
 *
 * Equal values share one numbered slot, so a statement that repeats a value
 * stays under SQLite's variable-number cap.
 */

import type { InValue } from "@libsql/client";
import { occurrencesIn, refusalOf } from "#fp";

declare const MADE_BY_SQL_TAG: unique symbol;

/** A statement and its bound arguments: the object form libsql runs. Only the
 * builders in this module can make one, so SQL text cannot arrive as a bare
 * string. */
export type SqlStatement = {
  readonly sql: string;
  readonly args: InValue[];
  readonly [MADE_BY_SQL_TAG]: true;
};

/** What a template slot can hold: a value to bind, or SQL to splice in. */
export type SqlSlot = InValue | SqlStatement;

/** One piece of a statement: SQL text, or a value that takes a slot. */
type Piece = string | { readonly bound: InValue };

/** The pieces behind each statement, so a statement inside another statement
 * is numbered again as part of the whole. */
const piecesBehind = new WeakMap<SqlStatement, readonly Piece[]>();

/** Whether a value is a statement that this module made. */
export const isSqlStatement = (slot: unknown): slot is SqlStatement =>
  typeof slot === "object" &&
  slot !== null &&
  piecesBehind.has(slot as SqlStatement);

const isBindable = (slot: unknown): slot is InValue =>
  slot === null ||
  ["string", "number", "bigint", "boolean"].includes(typeof slot) ||
  slot instanceof Uint8Array ||
  slot instanceof ArrayBuffer ||
  slot instanceof Date;

/** The pieces one template slot adds. */
const piecesOfSlot = (slot: SqlSlot): readonly Piece[] => {
  if (isSqlStatement(slot)) return piecesBehind.get(slot)!;
  if (isBindable(slot)) return [{ bound: slot }];
  throw new Error(
    `A value in SQL must be a statement or a value libsql can bind. Got ${
      Array.isArray(slot) ? "an array" : typeof slot
    }.`,
  );
};

/** A statement put into a plain string is a mistake: it loses its values. */
const refuseToBeText = refusalOf(
  "A statement is not text. Put it into a sql template.",
);

/** Number the slots and collect the arguments. */
const statementOf = (pieces: readonly Piece[]): SqlStatement => {
  const args: InValue[] = [];
  const slotOfValue = new Map<InValue, string>();
  let text = "";
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
      continue;
    }
    let slot = slotOfValue.get(piece.bound);
    if (slot === undefined) {
      slot = `?${args.push(piece.bound)}`;
      slotOfValue.set(piece.bound, slot);
    }
    text += slot;
  }
  const statement = { args, sql: text } as SqlStatement;
  Object.defineProperty(statement, "toString", { value: refuseToBeText });
  piecesBehind.set(statement, pieces);
  return statement;
};

/** Add pieces one at a time: a spread of a long list overflows the stack. */
const appendPieces = (pieces: Piece[], more: readonly Piece[]): void => {
  for (const piece of more) pieces.push(piece);
};

/** Where a reader of SQL text is: in SQL, in a quoted literal, or in a comment. */
type TextPlace = "sql" | "literal" | "line comment" | "block comment";

/** The marks that move a reader out of each place, and the place each mark
 * moves to. A doubled quote leaves a literal and enters it again. */
const PLACE_MOVES: Record<TextPlace, readonly [string, TextPlace][]> = {
  "block comment": [["*/", "sql"]],
  "line comment": [["\n", "sql"]],
  literal: [["'", "sql"]],
  sql: [
    ["'", "literal"],
    ["--", "line comment"],
    ["/*", "block comment"],
  ],
};

/** The place a reader is in after `text`, when it started in `place` at
 * `from`. The nearest mark moves the reader, and the read goes on after it. */
const placeAfter = (text: string, place: TextPlace, from = 0): TextPlace => {
  const [nearest] = occurrencesIn(
    text,
    ([mark]: readonly [string, TextPlace]) => mark,
    from,
  )(PLACE_MOVES[place]);
  if (nearest === undefined) return place;
  const [mark, to] = nearest.item;
  return placeAfter(text, to, nearest.at + mark.length);
};

/** Refuse a slot inside a quoted SQL literal. SQLite reads `'?1'` as text, so
 * the value never binds. */
const refuseSlotInQuotes = (strings: TemplateStringsArray): void => {
  let place: TextPlace = "sql";
  for (const text of strings.slice(0, -1)) {
    place = placeAfter(text, place);
    if (place === "literal") {
      throw new Error(
        `A slot sits inside a quoted SQL literal: ${strings.join("{slot}")}`,
      );
    }
  }
};

/** SQL from a template: text stays text, values bind, statements splice. */
export const sql = (
  strings: TemplateStringsArray,
  ...slots: readonly SqlSlot[]
): SqlStatement => {
  refuseSlotInQuotes(strings);
  const pieces: Piece[] = [strings[0]!];
  for (const [index, slot] of slots.entries()) {
    appendPieces(pieces, piecesOfSlot(slot));
    pieces.push(strings[index + 1]!);
  }
  return statementOf(pieces);
};

/** Statements joined into one, with `separator` between each pair. */
export const sqlJoin = (
  parts: readonly SqlStatement[],
  separator: SqlStatement,
): SqlStatement => {
  const pieces: Piece[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) appendPieces(pieces, piecesBehind.get(separator)!);
    appendPieces(pieces, piecesBehind.get(part)!);
  }
  return statementOf(pieces);
};

const COMMA = sql`, `;

/** Statements joined by commas: a column list, a SET list, VALUES rows. */
export const sqlCommas = (parts: readonly SqlStatement[]): SqlStatement =>
  sqlJoin(parts, COMMA);

/** A list of values, each bound, joined by commas: the body of an `IN (...)`
 * or of one VALUES row. */
export const sqlList = (values: readonly InValue[]): SqlStatement =>
  sqlCommas(values.map((value) => sql`${value}`));

/** Rows for a VALUES list: `(a, b), (c, d)`. A value in a row binds. A
 * statement in a row stays as written. */
export const sqlRows = (rows: readonly (readonly SqlSlot[])[]): SqlStatement =>
  sqlCommas(
    rows.map((row) => sql`(${sqlCommas(row.map((slot) => sql`${slot}`))})`),
  );

const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** A table, column, index or trigger name, optionally `table.column`. A name
 * is SQL text, so it must look like a name and nothing else. */
export const sqlName = (name: string): SqlStatement => {
  if (!NAME.test(name)) {
    throw new Error(`Not a valid SQL name: ${JSON.stringify(name)}`);
  }
  return statementOf([name]);
};

/** Names joined by commas: a column list. */
export const sqlNames = (names: readonly string[]): SqlStatement =>
  sqlCommas(names.map(sqlName));

/** One INSERT that writes every row, or null when there is no row. An INSERT
 * with an empty VALUES list is not valid SQL, so the caller leaves it out. */
export const sqlInsertRowsOrNull = (
  table: string,
  columns: readonly string[],
  rows: readonly (readonly SqlSlot[])[],
): SqlStatement | null =>
  rows.length === 0
    ? null
    : sql`INSERT INTO ${sqlName(table)} (${sqlNames(columns)}) VALUES ${sqlRows(rows)}`;

/** Whether a row of `table` satisfies `where`: an EXISTS probe. */
export const sqlExists = (table: string, where: SqlStatement): SqlStatement =>
  sql`EXISTS (SELECT 1 FROM ${sqlName(table)} WHERE ${where})`;

/** A constant written into the SQL text as a literal. For schema text, which
 * takes no bound arguments, and for a constant that a partial index names. */
export const sqlLiteral = (value: string | number): SqlStatement => {
  if (typeof value === "string") {
    return statementOf([`'${value.replaceAll("'", "''")}'`]);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Not a valid SQL number: ${value}`);
  }
  return statementOf([String(value)]);
};

/** A statement read back from a backup dump: SQL text that this application
 * exported to a file. Restore is the only caller. No other SQL arrives as
 * text. */
export const sqlFromDump = (text: string): SqlStatement => statementOf([text]);
