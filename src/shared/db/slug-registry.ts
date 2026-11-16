/**
 * Cross-table slug uniqueness. A slug must be unique across **listings,
 * groups, and site_pages**. The three share the public URL namespace and the
 * same blind-index hash, so all three entity validators delegate here.
 * Centralising it closes the one-directional gap where a per-entity check
 * looked at a subset. Without it, a later listing or group can reuse a page's
 * slug, or the reverse.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  queryBatch,
  resultRows,
  rowExists,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import {
  insertRowStatement,
  type NewRecord,
  type RecordChanges,
  rowById,
  updateRowStatement,
} from "#db/record-table.ts";
import { wholeCondition } from "#db/select/expression.ts";
import type { DecodedRowOf, TableHandle } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlJoin, sqlList, sqlName } from "#db/sql.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { SitePageItemType } from "#types";

/** The slug-owning tables (plural form, one per {@link SitePageItemType}). */
export type SlugTable = "listings" | "groups" | "site_pages";

/** Exhaustive {@link SitePageItemType} → {@link SlugTable} map. Adding a new
 *  slug-owning entity to {@link SitePageItemTypeSchema} forces a row here (a
 *  compile error). The cross-table uniqueness check then cannot miss the new
 *  table the way a hand-listed `SlugTable[]` can. */
const SLUG_TABLE_BY_TYPE: Record<SitePageItemType, SlugTable> = {
  group: "groups",
  listing: "listings",
  page: "site_pages",
};

const SLUG_TABLES: readonly SlugTable[] = Object.values(SLUG_TABLE_BY_TYPE);

type SlugOwnerTable = SlugTable | "news_posts";
type SlugOwner = { table: SlugOwnerTable; excludeId?: number };

/** SQL condition that is true only while no listed row owns `slugIndex`.
 * Callers put it directly in an INSERT/UPDATE statement, so the check and write
 * are one atomic database operation rather than a race-prone preflight. */
export const unclaimedSlugCondition = (
  slugIndex: string,
  owners: readonly SlugOwner[],
): SqlStatement =>
  sqlJoin(
    owners.map(
      (owner) =>
        sql`NOT EXISTS (SELECT 1 FROM ${sqlName(owner.table)} WHERE slug_index = ${slugIndex}${
          owner.excludeId === undefined
            ? sql``
            : sql` AND id != ${owner.excludeId}`
        })`,
    ),
    sql` AND `,
  );

/** Atomic availability condition for the shared listing/group/page namespace. */
export const unclaimedSiteSlugCondition = (
  slugIndex: string,
  exclude?: { table: SlugTable; id: number },
): SqlStatement =>
  unclaimedSlugCondition(
    slugIndex,
    SLUG_TABLES.map((table) => ({
      ...(exclude?.table === table ? { excludeId: exclude.id } : {}),
      table,
    })),
  );

/** The condition builder every slugged write takes: the fresh blind index
 * and the row being written, if any. */
export type UnclaimedSlugCondition = (
  slugIndex: BlindIndex,
  id: number | undefined,
) => SqlStatement;

/** The content tables whose rows own a slug and its blind index. */
export type SluggedTable = "news_posts" | "site_pages";

/** The values of a slugged write: never the blind index, which the write
 *  computes from the slug. */
type WithoutIndex<Values> = Omit<Values, "slug_index">;

/** The write surface {@link freshSlugIndexWrites} hands back for one table.
 * The blind index is always computed inside, never passed in, so `slug` and
 * `slug_index` move together. */
type SluggedContentWrites<Name extends SluggedTable> = {
  create: (
    values: (
      tx: TxScope,
    ) => Promise<WithoutIndex<NewRecord<Name>> & { slug: string }>,
    transaction?: TxScope,
  ) => Promise<Result<DecodedRowOf<Name>, "slugTaken">>;
  update: (
    id: number,
    changes: WithoutIndex<RecordChanges<Name>> & { slug: string },
    transaction?: TxScope,
  ) => Promise<Result<DecodedRowOf<Name>, "notFound" | "slugTaken">>;
};

/** Conditional writes for a slugged content table. The blind index is always
 * computed here from the slug (never caller-supplied), so `slug` and
 * `slug_index` move together, and every write carries the unclaimed-slug
 * condition, so a create or a rename stays unique in the namespace that
 * condition checks. */
export const freshSlugIndexWrites = <Name extends SluggedTable>(
  table: TableHandle<Name>,
  unclaimed: UnclaimedSlugCondition,
): SluggedContentWrites<Name> => ({
  create: (values, transaction) =>
    useTransaction(transaction, async (tx) => {
      const given = await values(tx);
      const slugIndex = await hmacHash(given.slug);
      const [created] = resultRows(
        await tx.execute(
          await insertRowStatement(
            table,
            // The values name every column but the index, which is added here.
            { ...given, slug_index: slugIndex } as NewRecord<Name>,
            { when: wholeCondition(unclaimed(slugIndex, undefined)) },
          ),
        ),
      );
      return created === undefined
        ? errorResult("slugTaken")
        : okResult(created);
    }),
  update: (id, changes, transaction) =>
    useTransaction(transaction, async (tx) => {
      const slugIndex = await hmacHash(changes.slug);
      const [updated] = resultRows(
        await tx.execute(
          await updateRowStatement(
            table,
            id,
            { ...changes, slug_index: slugIndex } as RecordChanges<Name>,
            wholeCondition(unclaimed(slugIndex, id)),
          ),
        ),
      );
      if (updated) return okResult(updated);
      // The failed update cannot tell a missing row from a slug conflict,
      // so only this rejection path reads the row.
      const exists =
        resultRows(await tx.execute(rowById(table, id).probe())).length > 0;
      return errorResult(exists ? "slugTaken" : "notFound");
    }),
});

/**
 * Is `slug` already used by any listing, group, or page? `exclude` skips one row
 * (the entity being edited) so it can keep its own slug.
 */
export const isSlugTakenAnywhere = async (
  slug: string,
  exclude?: { table: SlugTable; id: number },
): Promise<boolean> => {
  const slugIndex = await hmacHash(slug);
  const available = unclaimedSiteSlugCondition(slugIndex, exclude);
  return !(await rowExists(sql`SELECT 1 WHERE ${available}`));
};

/** Which of these blind indexes does any slug-owning table already hold? One
 * read per table in one batch — the batched form of
 * {@link isSlugTakenAnywhere} for a caller that creates many slugged rows at
 * once (the catalog bundle import), where one check per row would trip the
 * N+1 read guard. */
export const takenSlugIndexes = async (
  slugIndexes: readonly string[],
): Promise<Set<string>> => {
  if (slugIndexes.length === 0) return new Set();
  const results = await queryBatch(
    SLUG_TABLES.map(
      (table) =>
        sql`SELECT slug_index FROM ${sqlName(table)} WHERE slug_index IN (${sqlList(slugIndexes)})`,
    ),
  );
  return new Set(
    results.flatMap((result) =>
      resultRows<{ slug_index: string }>(result!).map((row) => row.slug_index),
    ),
  );
};

/** `isSlugTakenAnywhere` for the rows one entity can edit — a listing edit must
 * not trip on its own group's slug, and vice-versa. */
export const slugTakenIn =
  (table: SlugTable) =>
  (slug: string, excludeId?: number): Promise<boolean> =>
    isSlugTakenAnywhere(slug, excludeId ? { id: excludeId, table } : undefined);
