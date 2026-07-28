import type { Table } from "#shared/db/migrations/schema/types.ts";

/**
 * The kinds of column a payment record is built from, each in a "must be
 * there" and a "may be missing" form.
 *
 * SQLite is why they exist: a rule comparing against a missing value passes
 * rather than fails, and any column will hold text where a number was meant,
 * so both have to be said outright on every column. Saying them here once
 * means a new column cannot arrive weaker than the one beside it.
 */

/** Lets a rule pass when the value is not there at all. */
const orMissing = (name: string, rule: string): string =>
  `${name} IS NULL OR ${rule}`;

const column = (type: string, rule: string): string =>
  `${type} CHECK (${rule})`;

const withDefault = (type: string, fallback: string | number | undefined) =>
  `${type}${fallback === undefined ? "" : ` DEFAULT ${fallback}`}`;

/** Joins rules that must all hold, or of which one must. */
export const allOf = (rules: string[]): string => `(${rules.join(" AND ")})`;
export const anyOf = (rules: string[]): string => `(${rules.join(" OR ")})`;

/** Writes a list of words the way SQL wants to read them. */
export const quoted = (words: readonly string[]): string =>
  words.map((word) => `'${word}'`).join(", ");

/**
 * The smallest a number may be: a fixed floor, or the name of another column
 * on the same row — the moment a time is measured from, such as when the
 * payment was created.
 */
type Floor = number | string;

const realNumber = (name: string, floor: Floor): string =>
  `typeof(${name}) = 'integer' AND ${name} >= ${floor}`;

/** A whole number that is really a number and not below its floor. */
export const wholeNumber = (
  name: string,
  floor: Floor = 0,
  fallback?: number,
): string =>
  column(withDefault("INTEGER NOT NULL", fallback), realNumber(name, floor));

export const wholeNumberOrNull = (name: string, floor: Floor = 0): string =>
  column("INTEGER", orMissing(name, `(${realNumber(name, floor)})`));

/** A whole number with a top as well, for the columns holding money. */
export const amountOrNull = (name: string, floor: number): string =>
  column(
    "INTEGER",
    orMissing(
      name,
      `(typeof(${name}) = 'integer' AND ${name} BETWEEN ${floor} AND ${Number.MAX_SAFE_INTEGER})`,
    ),
  );

const saysSomething = (name: string): string => `length(trim(${name})) > 0`;

/** Text that says something, rather than being blank or only spaces. */
export const words = (name: string): string =>
  column("TEXT NOT NULL", saysSomething(name));

export const wordsOrNull = (name: string): string =>
  column("TEXT", orMissing(name, saysSomething(name)));

/** The payment's own name, which SQLite would otherwise let hold nothing. */
export const keyWords = (name: string): string =>
  column("TEXT PRIMARY KEY NOT NULL", saysSomething(name));

/**
 * Text hidden behind a whole envelope, not just its front. A value counts as
 * hidden only if it says how it was hidden and then carries every part needed
 * to read it back, so a bare prefix with the buyer's details after it is
 * refused — as it would have to be, since nothing could read it back either.
 */
const sealed = (name: string, prefix: string, parts: number): string =>
  `${name} GLOB '${prefix}${":?*".repeat(parts)}'`;

/** Hidden with this site's own key: a starting block, then the hidden text. */
export const ownSealed = (name: string): string => sealed(name, "enc:1", 2);

/** Carried over from an older version, which also wraps up the key it used. */
export const legacySealed = (name: string): string => sealed(name, "hyb:1", 3);

export const encryptedPaymentColumn = (name: string): string =>
  column("TEXT NOT NULL", ownSealed(name));

export const encryptedPaymentColumnOrNull = (name: string): string =>
  `(${orMissing(name, ownSealed(name))})`;

const oneOfWords = (name: string, allowed: readonly string[]): string =>
  `${name} IN (${quoted(allowed)})`;

/** One of a fixed set of words, and nothing else. */
export const oneOf = (
  name: string,
  allowed: readonly string[],
  fallback?: string,
): string =>
  column(
    withDefault("TEXT NOT NULL", fallback && `'${fallback}'`),
    oneOfWords(name, allowed),
  );

export const oneOfOrNull = (name: string, allowed: readonly string[]): string =>
  column("TEXT", orMissing(name, oneOfWords(name, allowed)));

/** Three capital letters, the shape every currency is written in. */
export const currencyOrNull = (name: string): string =>
  column("TEXT", orMissing(name, `${name} GLOB '[A-Z][A-Z][A-Z]'`));

/** When a row was made and last touched. Every payment record carries both,
 *  and the touch can never come before the making. */
export const madeAndTouched: [string, string][] = [
  ["created_at", wholeNumber("created_at")],
  ["updated_at", wholeNumber("updated_at", "created_at")],
];

/**
 * Rules about the row as a whole, hung on its last column because that is the
 * only place SQLite lets a table say them — so they read as one list of what a
 * record may never be, rather than being scattered over the columns.
 */
export const alsoAbout =
  (theRow: string[]) =>
  (base: string): string =>
    [base, ...theRow.map((rule) => `CHECK (${rule})`)].join("\n          ");

/**
 * Every record hanging off a payment opens the same way: its own row id, then
 * the payment it belongs to. Written once here so a new one cannot start any
 * other way.
 */
export const paymentRecord = (
  name: string,
  parts: {
    columns: [string, string][];
    indexes: NonNullable<Table["indexes"]>;
  },
): [name: string, table: Table] => [
  name,
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", words("payment_id")],
      ...parts.columns,
    ],
    indexes: parts.indexes,
  },
];
