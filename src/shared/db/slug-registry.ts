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
  existsOn,
  findRowWhere,
  insertRowStatement,
  type NewRecord,
  type RecordChanges,
  rowById,
  updateRowStatement,
} from "#db/record-table.ts";
import { equal, named, wholeCondition } from "#db/select/expression.ts";
import type { DecodedRowOf, TableHandle } from "#db/select/tables.ts";
import {
  contentValues,
  type SluggedContentInput,
} from "#db/slugged-content-input.ts";
import {
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlJoin,
  sqlList,
  sqlName,
} from "#db/sql.ts";
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

/** The read of the whole row whose slug has this blind index, or null when no
 *  row has it. */
export const rowBySlugIndex =
  <Name extends SluggedTable>(table: TableHandle<Name>) =>
  (slugIndex: BlindIndex): Promise<DecodedRowOf<Name> | null> =>
    findRowWhere(table, () =>
      equal(named<string>(`${table.singular}.slug_index`), slugIndex),
    );

/** The values of a slugged write: never the blind index, which the write
 *  computes from the slug. */
type WithoutIndex<Values> = Omit<Values, "slug_index">;

/** The write surface {@link freshSlugIndexWrites} hands back for one table.
 * The blind index is always computed inside, never passed in, so `slug` and
 * `slug_index` move together. */
type SluggedContentWrites<
  Name extends SluggedTable,
  Input extends Required<SluggedContentInput>,
> = {
  create: (
    input: Input,
    writtenColumns: (tx: TxScope) => Promise<WithoutIndex<RecordChanges<Name>>>,
    transaction?: TxScope,
  ) => Promise<Result<DecodedRowOf<Name>, "slugTaken">>;
  update: (
    id: number,
    input: Input,
    transaction?: TxScope,
  ) => Promise<Result<DecodedRowOf<Name>, "notFound" | "slugTaken">>;
};

/** Conditional writes for a slugged content table. The blind index is always
 * computed here from the slug (never caller-supplied), so `slug` and
 * `slug_index` move together, and every write carries the unclaimed-slug
 * condition, so a create or a rename stays unique in the namespace that
 * condition checks. An update writes the shared content fields of its input,
 * and the columns of the table's own fields that `ownColumns` gives. A create
 * also writes the columns that `writtenColumns` gives inside its transaction. */
export const freshSlugIndexWrites = <
  Name extends SluggedTable,
  Input extends Required<SluggedContentInput>,
>(
  table: TableHandle<Name>,
  unclaimed: UnclaimedSlugCondition,
  ownColumns: (input: Input) => WithoutIndex<RecordChanges<Name>>,
): SluggedContentWrites<Name, Input> => {
  /** Run one write of `input` with its fresh blind index, and answer from the
   *  row that the write gives back, if any. */
  const slugWrite = <Answer>(
    input: Input,
    transaction: TxScope | undefined,
    write: (
      tx: TxScope,
      values: WithoutIndex<RecordChanges<Name>>,
      slugIndex: BlindIndex,
    ) => Promise<RowsStatement<DecodedRowOf<Name>>>,
    answer: (
      row: DecodedRowOf<Name> | undefined,
      tx: TxScope,
    ) => Promise<Answer> | Answer,
  ): Promise<Answer> =>
    useTransaction(transaction, async (tx) => {
      const slugIndex = await hmacHash(input.slug);
      const values = { ...contentValues(input), ...ownColumns(input) };
      const [row] = resultRows(
        await tx.execute(await write(tx, values, slugIndex)),
      );
      return answer(row, tx);
    });
  return {
    create: (input, writtenColumns, transaction) =>
      slugWrite(
        input,
        transaction,
        async (tx, values, slugIndex) =>
          insertRowStatement(
            table,
            // The values name every column but the index, which is added here.
            {
              ...values,
              ...(await writtenColumns(tx)),
              slug_index: slugIndex,
            } as NewRecord<Name>,
            { when: wholeCondition(unclaimed(slugIndex, undefined)) },
          ),
        (row) => (row === undefined ? errorResult("slugTaken") : okResult(row)),
      ),
    update: (id, input, transaction) =>
      slugWrite(
        input,
        transaction,
        (_tx, values, slugIndex) =>
          updateRowStatement(
            table,
            id,
            { ...values, slug_index: slugIndex } as RecordChanges<Name>,
            () => wholeCondition(unclaimed(slugIndex, id)),
          ),
        // The failed update cannot tell a missing row from a slug conflict,
        // so only this rejection path reads the row.
        async (row, tx) =>
          row
            ? okResult(row)
            : errorResult(
                (await existsOn(tx, rowById(table, id)))
                  ? "slugTaken"
                  : "notFound",
              ),
      ),
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
