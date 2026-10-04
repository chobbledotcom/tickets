/**
 * String interning for free-text answers.
 *
 * Free-text answers are stored once in a `strings` table (encrypted with the
 * owner key) and referenced by id from `attendee_answers`. This keeps the
 * blob deduped and lets the age-based pruner drop genuinely-unused strings.
 */

import type { ResultSet } from "@libsql/client";
import { hmacHash } from "#crypto/hashing.ts";
import { encryptWithOwnerKey } from "#crypto/keys.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#crypto/sealed.ts";
/* jscpd:ignore-start */
import {
  executeBatchWithResults,
  inPlaceholders,
  resultRows,
  type SqlStatement,
} from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { nowIso } from "#shared/now.ts";
/* jscpd:ignore-end */

/** One free-text answer's encrypted payload plus its blind index and plaintext.
 *  Built by {@link prepareStringRows} (pure CPU: HMAC + hybrid encryption, no
 *  IO) so callers can do that work before opening a write transaction, then
 *  handed to {@link internStringRows} for the DB statements. */
export type PreparedStringRow = {
  encrypted: OwnerKeyEncrypted;
  text: string;
  textIndex: BlindIndex;
};

/** The interned id of each free-text answer, keyed by its plaintext — what the
 * interning functions all return so a caller can swap each answer for its id. */
export type StringIdByText = Map<string, number>;

/**
 * Throws when a `textIndex` is missing. The read runs in the same transaction
 * as the insert, so every index written must come back, and a miss means that
 * read-your-writes invariant broke.
 *
 * An `undefined` id would corrupt every caller silently. A checkout would drop
 * the `s` from its signed metadata, and the webhook would later bind
 * `undefined` into SQL. Failing here keeps that from escaping.
 */
export const pairStringIds = (
  rows: readonly { text: string; textIndex: string }[],
  found: readonly { id: number; text_index: string }[],
): StringIdByText => {
  const idByIndex = new Map(found.map((row) => [row.text_index, row.id]));
  return new Map(
    rows.map((row) => {
      const id = idByIndex.get(row.textIndex);
      if (id === undefined) {
        throw new Error(
          `String id missing immediately after insert (text_index=${row.textIndex})`,
        );
      }
      return [row.text, id];
    }),
  );
};

/**
 * Build the encrypted payload and blind index for each unique free-text answer —
 * the pure-CPU half of string interning (HMAC + hybrid encryption, no IO).
 * Callers that wrap their save in `withTransaction` should call this *before*
 * opening the transaction and hand the rows to {@link internStringRows} on the
 * tx, so the CPU-bound crypto work does not hold the SQLite writer open while no
 * DB statement is running. Dedupes the input via `Set` so each text interns once.
 */
export const prepareStringRows = async (
  texts: string[],
): Promise<PreparedStringRow[]> => {
  const uniqueTexts = [...new Set(texts)];
  return Promise.all(
    uniqueTexts.map(async (text) => ({
      encrypted: await encryptWithOwnerKey(text, settings.publicKey),
      text,
      textIndex: await hmacHash(text),
    })),
  );
};

/** Run the interning statements together and return the trailing SELECT. */
const runInternStatements = async (
  statements: SqlStatement[],
): Promise<ResultSet> => {
  const results = await executeBatchWithResults(statements);
  return results.at(-1)!;
};

/** The blind index of each prepared row, in row order — the key every
 * interning statement looks its strings up by. */
const textIndexes = (rows: readonly PreparedStringRow[]): BlindIndex[] =>
  rows.map(({ textIndex }) => textIndex);

/** The statements that create or refresh one interned string per row. A
 * caller that resolves string ids inside SQL (the reservation batch, where the
 * attendee answers insert runs as plain statements) rides on these writes and
 * never needs the trailing SELECT. */
export const internWriteStatements = (
  rows: PreparedStringRow[],
): SqlStatement[] => {
  const created = nowIso();
  const indexes = textIndexes(rows);
  return [
    {
      args: rows.flatMap((row) => [row.textIndex, row.encrypted, created]),
      sql: `INSERT OR IGNORE INTO strings (text_index, encrypted_text, created) VALUES ${rows
        .map(() => "(?, ?, ?)")
        .join(", ")}`,
    },
    // Refresh `created` on every referenced row. INSERT OR IGNORE leaves an
    // existing row's timestamp untouched, so without this the age-based prune
    // could delete a row a checkout still references in its signed metadata
    // (the trigger no longer deletes on used_count = 0, so the pruner is the
    // only thing that removes strings). Refreshing a row that is reused now —
    // even one currently attached to another attendee — keeps it alive past
    // that other attendee later freeing it, until this checkout finalizes.
    {
      args: [created, ...indexes],
      sql: `UPDATE strings SET created = ? WHERE text_index IN (${inPlaceholders(indexes)})`,
    },
  ];
};

/**
 * The trailing SELECT reads its own just-written rows. From a replica that has
 * not replicated the insert, a brand-new id comes back missing and the value is
 * silently lost, so every path here keeps the read in the INSERT's own
 * transaction.
 *
 * The `INSERT OR IGNORE` values batch into one multi-row statement, so interning
 * is a fixed 3 round trips however many unique strings a save carries. That is
 * what keeps it clear of the transaction round-trip guard.
 */
export const internStringRows = async (
  rows: PreparedStringRow[],
): Promise<StringIdByText> => {
  if (rows.length === 0) return new Map();
  const indexes = textIndexes(rows);
  const selectResult = await runInternStatements([
    ...internWriteStatements(rows),
    {
      args: indexes,
      sql: `SELECT id, text_index FROM strings WHERE text_index IN (${inPlaceholders(indexes)})`,
    },
  ]);
  const found = resultRows<{ id: number; text_index: string }>(selectResult);
  return pairStringIds(rows, found);
};

/**
 * Does the crypto and the DB work in one call, for the standalone path.
 *
 * A caller that already holds a write boundary must instead call
 * {@link prepareStringRows} *before* opening it (the crypto is CPU-bound and
 * holds no DB statement) and ride {@link internWriteStatements} on it — the
 * reservation boundary's answer save resolves the interned ids inside its own
 * batch rather than reading them back.
 */
export const getOrCreateStringIds = async (
  texts: string[],
): Promise<StringIdByText> => internStringRows(await prepareStringRows(texts));
