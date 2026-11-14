// effects: pure
/**
 * The one way to write SQL: the `sql` tag.
 *
 * Text inside the template is SQL. A value put into the template is never
 * text: it becomes a bound argument at the place it is written, so a value and
 * its placeholder cannot fall out of step. A statement put into another
 * statement brings its own values with it.
 *
 * Equal values share one numbered slot, so a statement that repeats a value
 * stays under SQLite's variable-number cap.
 */

import type { InValue } from "@libsql/client";

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

const isStatement = (slot: unknown): slot is SqlStatement =>
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
  if (isStatement(slot)) return piecesBehind.get(slot)!;
  if (isBindable(slot)) return [{ bound: slot }];
  throw new Error(
    `A value in SQL must be a statement or a value libsql can bind. Got ${
      Array.isArray(slot) ? "an array" : typeof slot
    }.`,
  );
};

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
  piecesBehind.set(statement, pieces);
  return statement;
};

/** SQL from a template: text stays text, values bind, statements splice. */
export const sql = (
  strings: TemplateStringsArray,
  ...slots: readonly SqlSlot[]
): SqlStatement => {
  const pieces: Piece[] = [strings[0]!];
  for (const [index, slot] of slots.entries()) {
    pieces.push(...piecesOfSlot(slot), strings[index + 1]!);
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
    if (index > 0) pieces.push(...piecesBehind.get(separator)!);
    pieces.push(...piecesBehind.get(part)!);
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
