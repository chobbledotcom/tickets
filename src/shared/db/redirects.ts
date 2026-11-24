/**
 * Redirects table operations.
 *
 * A redirect keeps the missing page as a blind index and as sealed text, and
 * keeps the new address as sealed text. No column holds plain text. Every
 * write also sets the `redirect_count` setting from the table in the same
 * transaction, so the count cannot drift from the rows.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  executeBatch,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { readOneRow } from "#db/read.ts";
import { newRecordOf, recordsOf } from "#db/record-table.ts";
import { wholeCondition } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { settings } from "#db/settings.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { requestCachedRows } from "#db/table-cache.ts";
import { deleteFrom } from "#db/write.ts";
import { redirectKeyOfTarget } from "#shared/redirect-paths.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

export type Redirect = DecodedRowOf<"redirects">;

/** A redirect to write: the key of the missing page and the new address, both
 *  already checked and normalised by the redirect rule. */
export type RedirectInput = { fromPath: string; toUrl: string };

/** Why a create writes nothing. */
export type RedirectConflict = "from_taken" | "to_is_redirect";

/** Every redirect in the order they were added. The sealed text is decrypted
 *  by its codec. */
export const redirects = requestCachedRows(tables.redirects, (rows) =>
  rows.sortedBy("id").pick("fromIndex", "fromPath", "id", "toUrl"),
);

/** How many redirects exist, read from the settings that every request loads.
 *  A site that never saved one has no stored count, and that reads as 0. */
export const redirectCount = (): number => Number(settings.redirectCount);

/** Set the stored count from the table, in the transaction of the write that
 *  changed the rows. */
const countStatement = (): SqlStatement =>
  sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${CONFIG_KEYS.REDIRECT_COUNT}, CAST((SELECT COUNT(*) FROM redirects AS redirect) AS TEXT))`;

/** The keys that a new redirect must not meet. One key is the page that it
 *  leaves. The other is the page that it enters, when that page is on this
 *  site. */
const indexesOf = async (
  input: RedirectInput,
): Promise<{ from: BlindIndex; keys: BlindIndex[] }> => {
  const fromIndex = await hmacHash(input.fromPath);
  const toKey = redirectKeyOfTarget(input.toUrl);
  return {
    from: fromIndex,
    keys: toKey === null ? [fromIndex] : [fromIndex, await hmacHash(toKey)],
  };
};

/** The reason the insert wrote nothing: the missing page already has a
 *  redirect, or the new address is a missing page that already redirects. */
const conflictOf = async (
  tx: TxScope,
  fromIndex: BlindIndex,
  keys: readonly BlindIndex[],
): Promise<RedirectConflict> => {
  const taken = resultRows<{ from_index: string }>(
    await tx.execute(
      sql`SELECT redirect.from_index FROM redirects AS redirect WHERE redirect.from_index IN (${sqlList(keys)})`,
    ),
  );
  return taken.some((row) => row.from_index === fromIndex)
    ? "from_taken"
    : "to_is_redirect";
};

/**
 * Add one redirect. The insert carries its own condition, so the check and
 * the write are one statement in one transaction. The condition has two
 * parts. No redirect can already leave the missing page. No redirect can
 * already leave the page that the new one enters. A redirect cannot enter a
 * redirect, so redirects can never close into a loop.
 */
export const createRedirect = (
  input: RedirectInput,
): Promise<Result<Redirect, RedirectConflict>> =>
  withTransaction(async (tx) => {
    const { from: fromIndex, keys } = await indexesOf(input);
    const [row] = resultRows(
      await tx.execute(
        await recordsOf(tables.redirects).insertStatement(
          newRecordOf(tables.redirects)({ ...input, fromIndex }),
          {
            when: wholeCondition(
              sql`NOT EXISTS (SELECT 1 FROM redirects AS redirect WHERE redirect.from_index IN (${sqlList(keys)}))`,
            ),
          },
        ),
      ),
    );
    if (row === undefined) {
      return errorResult(await conflictOf(tx, fromIndex, keys));
    }
    await tx.batch([countStatement(), settingsVersionIncrement()]);
    return okResult(row);
  });

/** Delete one redirect and set the stored count in the same batch. */
export const deleteRedirect = (id: number): Promise<unknown> =>
  executeBatch([
    deleteFrom(tables.redirects).where({ id }),
    countStatement(),
    settingsVersionIncrement(),
  ]);

/**
 * The address that a missing page redirects to, or null when no redirect
 * leaves the page. Null is the usual answer: most missing pages have no
 * redirect.
 */
export const redirectTargetOrNull = async (
  key: string,
): Promise<string | null> => {
  const row = await readOneRow(
    from(tables.redirects)
      .where({ fromIndex: await hmacHash(key) })
      .limit(1)
      .pick("toUrl"),
  );
  return row === null ? null : row.toUrl;
};
