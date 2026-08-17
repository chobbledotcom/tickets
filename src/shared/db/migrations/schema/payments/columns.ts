import type { Table } from "#shared/db/migrations/schema/types.ts";

/**
 * The kinds of column a payment record is built from.
 *
 * These say only what a column *is* — its type, whether it may be missing,
 * what it starts as. What a payment may say, and how it may behave, is the
 * record layer's to enforce in TypeScript, where a broken rule names itself,
 * can be unit tested without a database, and can be changed without rebuilding
 * a table already full of real money.
 *
 * The one exception is anything holding the buyer's details. That rule checks
 * what actually landed in the column rather than what the code meant to put
 * there, which is the one thing TypeScript cannot see: a type says `string`
 * while the value is bytes. It stays here, at the last point before the data
 * comes to rest.
 */

/** Joins rules of which one must hold. */
const withDefault = (type: string, fallback: string | number | undefined) =>
  `${type}${fallback === undefined ? "" : ` DEFAULT ${fallback}`}`;

export const wholeNumber = (fallback?: number): string =>
  withDefault("INTEGER NOT NULL", fallback);

export const wholeNumberOrNull = (): string => "INTEGER";

export const words = (fallback?: string): string =>
  withDefault("TEXT NOT NULL", fallback && `'${fallback}'`);

export const wordsOrNull = (): string => "TEXT";

/** The payment's own name, which SQLite would otherwise let hold nothing. */
export const keyWords = (): string => "TEXT PRIMARY KEY NOT NULL";

/**
 * Text hidden behind a whole envelope, not just its front. A value counts as
 * hidden only if it is really text, says how it was hidden, and then carries
 * every part needed to read it back — so a bare prefix with the buyer's
 * details after it is refused, as it would have to be, since nothing could
 * read it back either.
 *
 * Really text matters as much as the shape: SQLite leaves bytes alone in a
 * TEXT column while GLOB turns them into text just long enough to look at
 * them, so bytes spelling an envelope would otherwise pass and be stored as
 * bytes. GLOB's ?* also swallows more separators, so the second half refuses
 * one separator more than the envelope has.
 */
const sealed = (name: string, prefix: string, parts: number): string =>
  `(typeof(${name}) = 'text' AND ${name} GLOB '${prefix}${":?*".repeat(
    parts,
  )}' AND ${name} NOT GLOB '${prefix}${":*".repeat(parts + 1)}')`;

/** Hidden with this site's own key: a starting block, then the hidden text. */
const ownSealed = (name: string): string => sealed(name, "enc:1", 2);

/** Hidden for the owner with their public key, beyond the database key. */
export const ownerEncryptedPaymentColumn = (name: string): string =>
  `TEXT NOT NULL CHECK (${sealed(name, "hyb:1", 3)})`;

export const encryptedPaymentColumn = (name: string): string =>
  `TEXT NOT NULL CHECK (${ownSealed(name)})`;

export const encryptedPaymentColumnOrNull = (name: string): string =>
  `(${name} IS NULL OR ${ownSealed(name)})`;

/** When a row was made and last touched. Every payment record carries both. */
export const madeAndTouched: [string, string][] = [
  ["created_at", wholeNumber()],
  ["updated_at", wholeNumber()],
];

/**
 * Rules about the row as a whole, hung on its last column because that is the
 * only place SQLite lets a table say them.
 */
export const alsoAbout =
  (theRow: string[]): ((base: string) => string) =>
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
      ["payment_id", words()],
      ...parts.columns,
    ],
    indexes: parts.indexes,
  },
];
