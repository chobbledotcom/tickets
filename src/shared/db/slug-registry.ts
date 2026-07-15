/**
 * Cross-table slug uniqueness. A slug must be unique across **listings, groups,
 * and site_pages** — they share the public URL namespace and the same blind-index
 * hash — so all three entity validators delegate here. Centralising it closes the
 * one-directional gap where a per-entity check only looked at a subset (letting a
 * later listing/group reuse a page's slug, or vice versa).
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  resultRows,
  rowExists,
  type SqlStatement,
  type TxScope,
  useTransaction,
} from "#shared/db/client.ts";
import { type Table, writeTableRow } from "#shared/db/table.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { SitePageItemType } from "#shared/types.ts";

/** The slug-owning tables (plural form, one per {@link SitePageItemType}). */
export type SlugTable = "listings" | "groups" | "site_pages";

/** Exhaustive {@link SitePageItemType} → {@link SlugTable} map. Adding a new
 *  slug-owning entity to {@link SitePageItemTypeSchema} forces a row here (a
 *  compile error), so the cross-table uniqueness check can't silently miss the
 *  new table the way a hand-listed `SlugTable[]` could. */
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
): SqlStatement => ({
  args: owners.flatMap((owner) =>
    owner.excludeId === undefined ? [slugIndex] : [slugIndex, owner.excludeId],
  ),
  sql: owners
    .map(
      (owner) =>
        `NOT EXISTS (SELECT 1 FROM ${owner.table} WHERE slug_index = ?${
          owner.excludeId === undefined ? "" : " AND id != ?"
        })`,
    )
    .join(" AND "),
});

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

/** Run a conditional slug update and distinguish a missing row from a slug
 * conflict. The failed UPDATE itself cannot tell those two zero-row outcomes,
 * so only that rejection path performs the narrow id probe. */
export const updateRowWithUnclaimedSlug = <Row, Input>(
  table: Table<Row, Input>,
  id: number,
  input: Partial<Input>,
  condition: SqlStatement,
  transaction?: TxScope,
): Promise<Result<Row, "notFound" | "slugTaken">> =>
  useTransaction(transaction, async (tx) => {
    const row = await writeTableRow(tx, table, {
      condition,
      id,
      input,
      kind: "update",
    });
    if (row) return okResult(row);
    const exists =
      resultRows(
        await tx.execute({
          args: [id],
          sql: `SELECT ${table.primaryKey} FROM ${table.name} WHERE ${table.primaryKey} = ?`,
        }),
      ).length > 0;
    return errorResult(exists ? "slugTaken" : "notFound");
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
  return !(await rowExists(`SELECT 1 WHERE ${available.sql}`, available.args));
};
