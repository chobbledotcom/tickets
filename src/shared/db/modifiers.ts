/**
 * Modifiers table operations.
 *
 * Modifiers are owner-defined price rules (surcharges, discounts, add-ons).
 * There are typically only a handful, they are read on admin pages, and
 * (for now) nothing reads them on the hot public path, so this layer talks to
 * the table directly without a cache.
 */

import { inOwnTx, ledgerTx } from "#accounting/ledger-tx.ts";
import { accountBalanceSubquery } from "#accounting/projection-sql.ts";
import {
  executeBatch,
  queryAll,
  queryIdColumn,
  queryOne,
  requireOne,
  resultRows,
  type TxScope,
} from "#db/client.ts";
import {
  type AggregateRecalculation,
  type AggregateValues,
  aggregateRepairs,
} from "#db/common-schema.ts";
import { linkTableSide } from "#db/link-table.ts";
import { everyColumnPicked } from "#db/picked-columns.ts";
import type { ListsByIds } from "#db/query.ts";
import { readRows } from "#db/read.ts";
import { namesByIds } from "#db/record-table.ts";
import {
  among,
  type Condition,
  equal,
  notEqual,
  whereTail,
} from "#db/select/expression.ts";
import { from, tableNode } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { update } from "#db/write.ts";
import { emptyListsFor, requiredMapValue } from "#fp";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import type { Modifier } from "#types";

/** The stored modifier row. `totalRevenue` is not a column: every loader
 * projects it from the transfers ledger ({@link modifierRevenueSubquery}). */
export type ModifierRow = DecodedRowOf<"modifiers">;

/** Modifier input fields for create/update (camelCase, mapped to columns). */
export type ModifierInput = {
  name: string;
  calcKind: CalcKind;
  calcValue: number;
  direction: ModifierDirection;
  active?: boolean;
  trigger?: ModifierTrigger;
  code?: string;
  codeIndex?: string | null;
  maxPerOrder?: number | null;
  minVisits?: number;
  scope?: ModifierScope;
  minSubtotal?: number;
  stock?: number | null;
};

/** The modifier row of a statement that names the table `modifiers` bare. */
const MODIFIER_ROW = tableNode(tables.modifiers, "modifiers");

/** Every stored modifier column, which the client decodes. */
const STORED_COLUMNS = everyColumnPicked(tables.modifiers, "modifiers");

/**
 * Subquery projecting a modifier's revenue from the ledger: the modifier
 * account's NET balance (`balanceOf(modifier:M)`), read directly — never
 * negated. A surcharge bills the attendee (attendee→modifier), a discount funds
 * them (modifier→attendee), so the signed balance is exactly the modifier's net
 * effect on revenue. `idExpr` is the SQL for the modifier's id in the
 * surrounding query (always qualified — `modifiers.id` — because the correlated
 * subquery's FROM is `transfers`, which also has an `id`). Reused by every
 * modifier loader so revenue is read from the ledger in exactly one place,
 * never off the now-dropped column. The trailing `AS totalRevenue` names the
 * projected column.
 */
const modifierRevenueSubquery = (): SqlStatement =>
  sql`${accountBalanceSubquery("modifier", MODIFIER_ROW.id)} AS totalRevenue`;

/** A modifier row with the ledger-projected totalRevenue its loader selected.
 * SQLite can give the sum back as a bigint. */
const withRevenue = (
  row: ModifierRow & { totalRevenue: number | bigint },
): Modifier => ({ ...row, totalRevenue: Number(row.totalRevenue) });

const modifierSelect = (parts: readonly Condition[]): SqlStatement =>
  STORED_COLUMNS.decoded(
    sql`SELECT ${STORED_COLUMNS.list}, ${modifierRevenueSubquery()} FROM modifiers${whereTail(parts)} ORDER BY id ASC`,
  );

/** The rows of a modifier read. */
type StoredModifier = ModifierRow & { totalRevenue: number | bigint };

/** Read the modifiers the clauses select, decrypted, oldest first. */
const queryModifiersWhere = async (
  parts: readonly Condition[],
): Promise<Modifier[]> =>
  (await queryAll<StoredModifier>(modifierSelect(parts))).map(withRevenue);

/** Get all modifiers, decrypted, ordered by id. */
export const getAllModifiers = (): Promise<Modifier[]> =>
  queryModifiersWhere([]);

/** Read and decrypt names only for the requested modifier ids. */
export const getModifierNamesByIds = namesByIds(tables.modifiers);

/** Get the active modifiers, decrypted, ordered by id. An optional transaction
 * reads the same rows through it, so a reachability guard inside a write
 * transaction sees that transaction's own earlier writes. */
export const getActiveModifiers = async (tx?: TxScope): Promise<Modifier[]> => {
  const parts = [equal(MODIFIER_ROW.active, 1)];
  return tx === undefined
    ? queryModifiersWhere(parts)
    : resultRows<StoredModifier>(await tx.execute(modifierSelect(parts))).map(
        withRevenue,
      );
};

/** Get a single modifier by id, decrypted, with its ledger-projected
 * totalRevenue — the single-row read the admin edit/recalculate pages use, so
 * they see the projected figure rather than the dropped column (the bare
 * a plain read of the table returns only the stored {@link ModifierRow}). */
export const getModifier = async (id: number): Promise<Modifier | null> => {
  const row = await queryOne<StoredModifier>(
    modifierSelect([equal(MODIFIER_ROW.id, id)]),
  );
  return row ? withRevenue(row) : null;
};

export const MODIFIER_AGGREGATE_FIELDS = ["totalUses", "usageCount"] as const;

export type ModifierAggregateField = (typeof MODIFIER_AGGREGATE_FIELDS)[number];

export type ModifierAggregateValues = AggregateValues<ModifierAggregateField>;

export type ModifierAggregateRecalculation =
  AggregateRecalculation<ModifierAggregateField>;

/** The modifier count aggregates as they would be if rebuilt from usage rows.
 * Takes the stored {@link ModifierRow} — totalRevenue is no longer a
 * recalculable aggregate (it projects from the ledger), so only the counts are
 * compared. */
export const getModifierAggregateRecalculation = async (
  modifier: ModifierRow,
): Promise<ModifierAggregateRecalculation> => {
  const row = await requireOne<ModifierAggregateValues>(
    sql`SELECT
       COALESCE(SUM(quantity), 0) AS totalUses,
       COUNT(*) AS usageCount
     FROM modifier_usages
     WHERE modifier_id = ${modifier.id}`,
  );
  return {
    totalUses: { current: modifier.totalUses, recalculated: row.totalUses },
    usageCount: {
      current: modifier.usageCount,
      recalculated: row.usageCount,
    },
  };
};

/**
 * Correct a modifier's projected revenue to `targetRevenue` in its own write
 * transaction — the standalone form of `ledgerTx.correct.modifierRevenue` (see
 * {@link ledgerTx}). Revenue is `balanceOf(modifier:M)`, so raising it credits the
 * modifier account (`writeoff → modifier`) and lowering it debits it
 * (`modifier → writeoff`); the signed balance moves by the delta either way. The
 * delta is recomputed from the current projection read inside the transaction, so
 * re-submitting the same target is idempotent and a no-op when already met.
 */
export const adjustModifierRevenue = inOwnTx(ledgerTx.correct.modifierRevenue);

/** Write the operator's typed modifier aggregates, or rebuild chosen ones from
 * the usage rows they count. */
export const modifierAggregates = aggregateRepairs(tables.modifiers, {
  totalUses: sql`COALESCE((SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = modifiers.id), 0)`,
  usageCount: sql`(SELECT COUNT(*) FROM modifier_usages WHERE modifier_id = modifiers.id)`,
});

/** The listings a "listings"-scoped modifier is charged on, keyed by modifier
 * id: `getIds` reads them (the admin scope editor), `setIds` replaces the set
 * on save (deduped, idempotent). */
export const modifierListings = linkTableSide(
  tables.modifier_listings,
  "modifierId",
  "listingId",
);

/** The groups a "groups"-scoped modifier is charged on, keyed by modifier id —
 * same shape as {@link modifierListings}. */
export const modifierGroups = linkTableSide(
  tables.modifier_groups,
  "modifierId",
  "groupId",
);

type ModifierListingLinkRow = { listing_id: number; modifier_id: number };

const appendModifierListingLinks = (
  links: Map<number, number[]>,
  rows: ModifierListingLinkRow[],
): Map<number, number[]> => {
  for (const row of rows) {
    requiredMapValue(
      links,
      row.modifier_id,
      `Modifier ${row.modifier_id} missing`,
    ).push(row.listing_id);
  }
  return links;
};

/** Build a batched modifier->listing scope lookup: the returned function runs
 * `buildSql` (given the bound id list) and buckets the rows by
 * modifier id. */
const modifierScopeListingIdsLookup =
  (buildSql: (modifierIds: SqlStatement) => SqlStatement) =>
  async (
    modifierIds: number[],
    tx?: TxScope,
  ): Promise<Map<number, number[]>> => {
    if (modifierIds.length === 0) return new Map();
    const statement = buildSql(sqlList(modifierIds));
    const rows =
      tx === undefined
        ? await queryAll<ModifierListingLinkRow>(statement)
        : resultRows<ModifierListingLinkRow>(await tx.execute(statement));
    return appendModifierListingLinks(
      emptyListsFor<number, number>(modifierIds),
      rows,
    );
  };

/** Listing ids belonging to linked groups for each group-scoped modifier id. */
export const getModifierGroupListingIdsByModifierId =
  modifierScopeListingIdsLookup(
    (modifierIds) =>
      sql`SELECT modifierGroup.modifier_id, groupListing.listing_id AS listing_id
       FROM modifier_groups AS modifierGroup
         JOIN group_listings AS groupListing ON groupListing.group_id = modifierGroup.group_id
       WHERE modifierGroup.modifier_id IN (${modifierIds})`,
  );

/** Answer ids an "answer"-triggered modifier is linked to (for the admin
 * editor) — i.e. the answers whose modifier_id points at this modifier. */
export const getModifierAnswerIds = (modifierId: number): Promise<number[]> =>
  queryIdColumn(from(tables.answers).where({ modifierId }).pick("id"));

/** Point the given answers at an "answer"-triggered modifier (and clear any
 * answers previously pointing at it), so saving the editor is idempotent and
 * an answer carries at most one modifier. The links live on the answers rows
 * themselves (a `modifier_id` column), so this is a clear-then-point batch
 * rather than a link-table replace. */
export const setModifierAnswers = (
  modifierId: number,
  answerIds: number[],
): Promise<void> =>
  executeBatch([
    update(tables.answers, { modifierId: null }).where({
      modifierId,
    }),
    ...answerIds.map((id) =>
      update(tables.answers, { modifierId }).where({ id }),
    ),
  ]);

/** Selected answer id → the "answer"-trigger modifier it activates (as a
 * single-element list, absent when the answer has no modifier), keyed for
 * resolve so a modifier's quantity totals across every chosen answer that
 * points at it. */
export const modifierIdsByAnswerId: ListsByIds = async (answerIds) =>
  new Map(
    (
      await readRows(
        from(tables.answers)
          .where((answer) => [
            among(answer.id, answerIds),
            notEqual(answer.modifierId, null),
          ])
          .pick("id", "modifierId"),
      )
    ).flatMap(({ id, modifierId }) =>
      modifierId === null ? [] : [[id, [modifierId]] as const],
    ),
  );
