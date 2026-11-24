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

/** Why a create writes nothing. The missing page already has a redirect, or
 *  the new address is a page that already redirects, or a redirect already
 *  enters the missing page. */
export type RedirectConflict =
  | "from_is_target"
  | "from_taken"
  | "to_is_redirect";

/** Every redirect in the order they were added. The sealed text is decrypted
 *  by its codec. */
export const redirects = requestCachedRows(tables.redirects, (rows) =>
  rows.sortedBy("id").pick("fromIndex", "fromPath", "id", "toIndex", "toUrl"),
);

/** How many redirects exist, read from the settings that every request loads.
 *  A site that never saved one has no stored count, and that reads as 0. */
export const redirectCount = (): number => Number(settings.redirectCount);

/** Set the stored count from the table, in the transaction of the write that
 *  changed the rows. */
const countStatement = (): SqlStatement =>
  sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${CONFIG_KEYS.REDIRECT_COUNT}, CAST((SELECT COUNT(*) FROM redirects AS redirect) AS TEXT))`;

/** The blind indexes of a new redirect. `to` is the index of the page that it
 *  enters, or null when it enters another site. */
const indexesOf = async (
  input: RedirectInput,
): Promise<{ from: BlindIndex; to: BlindIndex | null }> => {
  const toKey = redirectKeyOfTarget(input.toUrl);
  return {
    from: await hmacHash(input.fromPath),
    to: toKey === null ? null : await hmacHash(toKey),
  };
};

/** The redirects that a new one must not meet. One leaves the page that the
 *  new one leaves. One leaves the page that the new one enters. One enters the
 *  page that the new one leaves. */
const meetingCondition = (from: BlindIndex, to: BlindIndex | null) =>
  sql`redirect.from_index IN (${sqlList(to === null ? [from] : [from, to])}) OR redirect.to_index = ${from}`;

/** The reason the insert wrote nothing. */
const conflictOf = async (
  tx: TxScope,
  from: BlindIndex,
  to: BlindIndex | null,
): Promise<RedirectConflict> => {
  const met = resultRows<{ from_index: string }>(
    await tx.execute(
      sql`SELECT redirect.from_index FROM redirects AS redirect WHERE ${meetingCondition(from, to)}`,
    ),
  ).map((row) => row.from_index);
  if (met.includes(from)) return "from_taken";
  return to !== null && met.includes(to) ? "to_is_redirect" : "from_is_target";
};

/**
 * Add one redirect. The insert carries its own condition, so the check and
 * the write are one statement in one transaction. No redirect can already
 * leave the missing page. No redirect can already leave the page that the new
 * one enters, and none can already enter the page that the new one leaves. A
 * redirect never enters a redirect, so redirects never chain and never close
 * into a loop, whatever the order of the adds.
 */
export const createRedirect = (
  input: RedirectInput,
): Promise<Result<Redirect, RedirectConflict>> =>
  withTransaction(async (tx) => {
    const { from, to } = await indexesOf(input);
    const [row] = resultRows(
      await tx.execute(
        await recordsOf(tables.redirects).insertStatement(
          newRecordOf(tables.redirects)({
            ...input,
            fromIndex: from,
            toIndex: to,
          }),
          {
            when: wholeCondition(
              sql`NOT EXISTS (SELECT 1 FROM redirects AS redirect WHERE ${meetingCondition(from, to)})`,
            ),
          },
        ),
      ),
    );
    if (row === undefined) return errorResult(await conflictOf(tx, from, to));
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
