/**
 * String interning for free-text answers.
 *
 * Free-text answers are stored once in a `strings` table (encrypted with the
 * owner key) and referenced by id from `attendee_answers`. This keeps the
 * blob deduped and lets the age-based pruner drop genuinely-unused strings.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import {
  executeBatchWithResults,
  inPlaceholders,
  resultRows,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Pair each just-written string (`text` + its `textIndex`) with the id the
 * post-insert SELECT returned, keyed by text.
 *
 * Throws if any `textIndex` is missing from `found`. In `getOrCreateStringIds`
 * the read runs in the same write-mode batch as the insert (one primary
 * transaction), so every index we wrote must come back; a miss means that
 * read-your-writes invariant broke. Returning an `undefined` id instead would
 * corrupt every caller silently — a checkout would drop the `s` from its signed
 * metadata and the webhook would later bind `undefined` into SQL ("Unsupported
 * type of value"). Failing loudly here keeps the corruption from escaping.
 */
export const pairStringIds = (
  rows: readonly { text: string; textIndex: string }[],
  found: readonly { id: number; text_index: string }[],
): Map<string, number> => {
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

export const getOrCreateStringIds = async (
  texts: string[],
): Promise<Map<string, number>> => {
  if (texts.length === 0) return new Map();
  const uniqueTexts = [...new Set(texts)];
  const rows = await Promise.all(
    uniqueTexts.map(async (text) => ({
      encrypted: await encryptWithOwnerKey(text, settings.publicKey),
      text,
      textIndex: await hmacHash(text),
    })),
  );
  const created = nowIso();
  const textIndexes = rows.map((r) => r.textIndex);
  // Insert, refresh `created`, and read the ids back in ONE write-mode batch.
  // A write batch is a single transaction forwarded to the primary, so the
  // trailing SELECT reads its own just-inserted rows. Reading the ids with a
  // separate query would be a plain read the platform may serve from a replica
  // that has not yet replicated the insert — for a brand-new string it returns
  // no row, the id resolves to undefined, and the value is silently lost.
  const results = await executeBatchWithResults([
    ...rows.map((row) => ({
      args: [row.textIndex, row.encrypted, created],
      sql: "INSERT OR IGNORE INTO strings (text_index, encrypted_text, created) VALUES (?, ?, ?)",
    })),
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
  ]);
  const found = resultRows<{ id: number; text_index: string }>(results.at(-1)!);
  return pairStringIds(rows, found);
};
