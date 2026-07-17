/**
 * String interning for free-text answers.
 *
 * Free-text answers are stored once in a `strings` table (encrypted with the
 * owner key) and referenced by id from `attendee_answers`. This keeps the
 * blob deduped and lets the age-based pruner drop genuinely-unused strings.
 */

import type { ResultSet } from "@libsql/client";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
/* jscpd:ignore-start */
import {
  executeBatchWithResults,
  inPlaceholders,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
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
 * Pair each just-written string (`text` + its `textIndex`) with the id the
 * post-insert SELECT returned, keyed by text.
 *
 * Throws if any `textIndex` is missing from `found`. In `getOrCreateStringIds`
 * the read runs in the same transaction as the insert (one write-mode batch when
 * standalone, or the caller's open `tx` when threaded through), so every index
 * we wrote must come back; a miss means that read-your-writes invariant broke.
 * Returning an `undefined` id instead would corrupt every caller silently — a
 * checkout would drop the `s` from its signed metadata and the webhook would
 * later bind `undefined` into SQL ("Unsupported type of value"). Failing loudly
 * here keeps the corruption from escaping.
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
  tx?: TxScope,
): Promise<ResultSet> => {
  const results = await (tx
    ? tx.batch(statements)
    : executeBatchWithResults(statements));
  return results.at(-1)!;
};

/**
 * Run the intern DB statements (insert-or-ignore, refresh `created`, read-back)
 * for `rows` and return the `text → id` map. The trailing SELECT reads its own
 * just-written rows: a brand-new string's id read from a replica that hasn't
 * replicated the insert comes back missing, so the id resolves to undefined and
 * the value is silently lost. When `tx` is given each statement runs on the
 * caller's open transaction, so the SELECT sees the INSERT's rows within that
 * transaction; otherwise one `executeBatchWithResults` write
 * batch is a single primary-pinned transaction that holds the same invariant.
 *
 * The per-text `INSERT OR IGNORE` values are batched into one multi-row
 * statement so the interning phase is a fixed 3 round trips regardless of how
 * many unique free-text strings are being saved — keeping the transaction
 * round-trip guard clear (the old per-text shape could blow past it for a save
 * with many unique texts).
 */
export const internStringRows = async (
  rows: PreparedStringRow[],
  tx?: TxScope,
): Promise<StringIdByText> => {
  if (rows.length === 0) return new Map();
  const created = nowIso();
  const textIndexes = rows.map((r) => r.textIndex);
  const statements: SqlStatement[] = [
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
      args: [created, ...textIndexes],
      sql: `UPDATE strings SET created = ? WHERE text_index IN (${inPlaceholders(textIndexes)})`,
    },
    {
      args: textIndexes,
      sql: `SELECT id, text_index FROM strings WHERE text_index IN (${inPlaceholders(textIndexes)})`,
    },
  ];
  const selectResult = await runInternStatements(statements, tx);
  const found = resultRows<{ id: number; text_index: string }>(selectResult);
  return pairStringIds(rows, found);
};

/**
 * Intern a list of free-text answers, returning the `text → id` map. Encrypts
 * and HMAC-indexes each unique text, then inserts-or-ignores, refreshes
 * `created`, and reads the ids back in one atomic batch. When `tx` is given,
 * every statement runs together on the caller's open transaction (so
 * the read-your-writes SELECT shares the INSERT's transaction); otherwise as
 * one `executeBatchWithResults` write batch.
 *
 * Callers wrapping their save in `withTransaction` should call
 * {@link prepareStringRows} *before* opening the transaction (to keep the
 * CPU-bound crypto out of the write-lock window) and then
 * {@link internStringRows} on the tx. This entry point does both in one call
 * for the standalone path and callers that don't need that separation.
 */
export const getOrCreateStringIds = async (
  texts: string[],
  tx?: TxScope,
): Promise<StringIdByText> =>
  internStringRows(await prepareStringRows(texts), tx);
