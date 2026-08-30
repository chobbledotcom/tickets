/**
 * Cross-table slug uniqueness. A slug must be unique across **listings, groups,
 * and site_pages** — they share the public URL namespace and the same blind-index
 * hash — so all three entity validators delegate here. Centralising it closes the
 * one-directional gap where a per-entity check only looked at a subset (letting a
 * later listing/group reuse a page's slug, or vice versa).
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  resultRows,
  rowExists,
  type SqlStatement,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import type { SluggedContentInput } from "#db/slugged-content-input.ts";
import { type Table, writeTableRow } from "#db/table.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { SitePageItemType } from "#types";

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

/** The condition builder every slugged write takes: the fresh blind index
 * and the row being written, if any. */
export type UnclaimedSlugCondition = (
  slugIndex: BlindIndex,
  id: number | undefined,
) => SqlStatement;

/** Extra create fields that can never re-point the slug or its blind index. */
type FieldsExtra<Input> = Partial<Omit<Input, "slug" | "slugIndex">>;

/** The write surface {@link freshSlugIndexWrites} hands back for one table.
 * The blind index is always computed inside, never passed in, so `slug` and
 * `slug_index` move together — the extra fields a create may add can never
 * move either one. */
type SluggedContentWrites<Row, Input extends SluggedContentInput> = {
  create: (
    input: Omit<Input, "slugIndex">,
    extra: (tx: TxScope) => Promise<FieldsExtra<Input>>,
    transaction?: TxScope,
  ) => Promise<Result<Row, "slugTaken">>;
  update: (
    id: number,
    input: Omit<Input, "slugIndex">,
    transaction?: TxScope,
  ) => Promise<Result<Row, "notFound" | "slugTaken">>;
};

/** Conditional writes for a slugged content table. The blind index is always
 * computed here from the body's slug (never caller-supplied), so `slug` and
 * `slug_index` move together, and every write carries the unclaimed-slug
 * condition, so a create or a rename stays unique in the namespace that
 * condition checks. */
export const freshSlugIndexWrites = <Row, Input extends SluggedContentInput>(
  table: Table<Row, Input>,
  unclaimed: UnclaimedSlugCondition,
): SluggedContentWrites<Row, Input> => {
  const write = async (
    tx: TxScope,
    rowAt: number | undefined,
    input: Omit<Input, "slugIndex">,
    extra: FieldsExtra<Input>,
  ): Promise<Row | null> => {
    const slugIndex = await hmacHash(input.slug);
    // The spread rebuilds the table input minus the computed index.
    const fields = { ...input, ...extra, slugIndex } as Input;
    return rowAt === undefined
      ? writeTableRow(tx, table, {
          condition: unclaimed(slugIndex, undefined),
          input: fields,
          kind: "insert",
        })
      : writeTableRow(tx, table, {
          condition: unclaimed(slugIndex, rowAt),
          id: rowAt,
          input: fields,
          kind: "update",
        });
  };
  return {
    // The writes stay inferred from SluggedContentWrites, the declared
    // contract at the factory's return type.
    create: (input, extra, transaction) =>
      useTransaction(transaction, async (tx) => {
        const created = await write(tx, undefined, input, await extra(tx));
        return created === null ? errorResult("slugTaken") : okResult(created);
      }),
    update: (id, input, transaction) =>
      useTransaction(transaction, async (tx) => {
        const updated = await write(tx, id, input, {});
        if (updated) return okResult(updated);
        // The failed UPDATE cannot tell a missing row from a slug conflict,
        // so only this rejection path performs the narrow id probe.
        const exists =
          resultRows(
            await tx.execute({
              args: [id],
              sql: `SELECT ${table.primaryKey} FROM ${table.name} WHERE ${table.primaryKey} = ?`,
            }),
          ).length > 0;
        return errorResult(exists ? "slugTaken" : "notFound");
      }),
  };
};

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
