/**
 * Modifiers table operations.
 *
 * Modifiers are owner-defined price rules (surcharges, discounts, add-ons).
 * There are typically only a handful, they are read on admin pages, and
 * (for now) nothing reads them on the hot public path, so this layer talks to
 * the table directly without a cache.
 */

import { inOwnTx, ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { accountBalanceSubquery } from "#shared/accounting/projection-sql.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  queryOne,
  resetAggregates,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
} from "#shared/db/common-schema.ts";
import { columnMapByIds, queryAndMap } from "#shared/db/query.ts";
import { col } from "#shared/db/table.ts";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";

/** The stored modifier row. `total_revenue` is NOT a column — it is projected
 * from the transfers ledger at read time (see {@link modifierRevenueSubquery})
 * and merged onto the read type {@link Modifier} — so it is absent here, exactly
 * as `listings.income` is absent from the listings table row. */
export type ModifierRow = Omit<Modifier, "total_revenue">;

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
  minVisits?: number;
  scope?: ModifierScope;
  minSubtotal?: number;
  stock?: number | null;
};

/** Modifiers table with CRUD operations. Name is encrypted at rest, matching
 * the other owner-defined entities. Behavioural columns (active, trigger,
 * scope, min_subtotal) have sensible defaults so the base create form need
 * only supply the pricing rule; later admin fields populate the rest. */
export const modifiersTable = defineIdTable<ModifierRow, ModifierInput>(
  "modifiers",
  {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
    active: col.boolean(true),
    calc_kind: col.simple<CalcKind>(),
    calc_value: col.simple<number>(),
    code: col.encryptedText(encrypt, decrypt),
    code_index: col.withDefault<string | null>(() => null),
    direction: col.simple<ModifierDirection>(),
    min_subtotal: col.withDefault(() => 0),
    min_visits: col.withDefault(() => 0),
    scope: col.withDefault<ModifierScope>(() => "all"),
    stock: col.withDefault<number | null>(() => null),
    // Trigger-maintained aggregates over modifier_usages — read-only here
    // (generated), so insert/update never write them and the DB default / the
    // triggers keep them current. total_revenue is no longer a column: it is
    // projected from the transfers ledger by {@link modifierRevenueSubquery},
    // which every loader selects alongside `modifiers.*`.
    total_uses: col.generated<number>(),
    trigger: col.withDefault<ModifierTrigger>(() => "automatic"),
    usage_count: col.generated<number>(),
  },
);

/**
 * Subquery projecting a modifier's revenue from the ledger: the modifier
 * account's NET balance (`balanceOf(modifier:M)`), read directly — never
 * negated. A surcharge bills the attendee (attendee→modifier), a discount funds
 * them (modifier→attendee), so the signed balance is exactly the modifier's net
 * effect on revenue. `idExpr` is the SQL for the modifier's id in the
 * surrounding query (always qualified — `modifiers.id` — because the correlated
 * subquery's FROM is `transfers`, which also has an `id`). Reused by every
 * `SELECT *` loader so revenue is read from the ledger in exactly one place,
 * never off the now-dropped column. The trailing `AS total_revenue` names the
 * projected column.
 */
export const modifierRevenueSubquery = (idExpr: string): string =>
  `${accountBalanceSubquery("modifier", idExpr)} AS total_revenue`;

/** Decrypt a modifier row and merge the ledger-projected total_revenue its
 * loader selected alongside `modifiers.*`. The row carries `total_revenue` from
 * {@link modifierRevenueSubquery} (the column itself is gone), so it is always a
 * number. Mirrors `decryptListingWithCount`'s attach-the-projection step. */
const mapModifierRow = async (row: Modifier): Promise<Modifier> => ({
  ...(await modifiersTable.fromDb(row)),
  total_revenue: Number(row.total_revenue),
});

/** Execute a query and decrypt the resulting modifier rows, merging the
 * ledger-projected total_revenue every loader selects alongside `modifiers.*`. */
const queryModifiers = queryAndMap<Modifier, Modifier>(mapModifierRow);

/** Get all modifiers, decrypted, ordered by id. */
export const getAllModifiers = (): Promise<Modifier[]> =>
  queryModifiers(
    `SELECT *, ${modifierRevenueSubquery("modifiers.id")} FROM modifiers ORDER BY id ASC`,
  );

/** Get the active modifiers, decrypted, ordered by id. */
export const getActiveModifiers = (): Promise<Modifier[]> =>
  queryModifiers(
    `SELECT *, ${modifierRevenueSubquery("modifiers.id")} FROM modifiers WHERE active = 1 ORDER BY id ASC`,
  );

/** Get a single modifier by id, decrypted, with its ledger-projected
 * total_revenue — the single-row read the admin edit/recalculate pages use, so
 * they see the projected figure rather than the dropped column (the bare
 * `modifiersTable.findById` returns only the stored {@link ModifierRow}). */
export const getModifier = async (id: number): Promise<Modifier | null> => {
  const row = await queryOne<Modifier>(
    `SELECT *, ${modifierRevenueSubquery("modifiers.id")} FROM modifiers WHERE id = ?`,
    [id],
  );
  return row ? mapModifierRow(row) : null;
};

export const MODIFIER_AGGREGATE_FIELDS = ["total_uses", "usage_count"] as const;

export type ModifierAggregateField = (typeof MODIFIER_AGGREGATE_FIELDS)[number];

export type ModifierAggregateValues = Record<ModifierAggregateField, number>;

export type ModifierAggregateRecalculation = Record<
  ModifierAggregateField,
  { current: number; recalculated: number }
>;

/** The modifier count aggregates as they would be if rebuilt from usage rows.
 * Takes the stored {@link ModifierRow} — total_revenue is no longer a
 * recalculable aggregate (it projects from the ledger), so only the counts are
 * compared. */
export const getModifierAggregateRecalculation = async (
  modifier: ModifierRow,
): Promise<ModifierAggregateRecalculation> => {
  const row = (await queryOne<ModifierAggregateValues>(
    `SELECT
       COALESCE(SUM(quantity), 0) AS total_uses,
       COUNT(*) AS usage_count
     FROM modifier_usages
     WHERE modifier_id = ?`,
    [modifier.id],
  ))!;
  return {
    total_uses: { current: modifier.total_uses, recalculated: row.total_uses },
    usage_count: {
      current: modifier.usage_count,
      recalculated: row.usage_count,
    },
  };
};

/** Manually set every editable modifier aggregate from the edit form. */
export const updateModifierAggregateValues = async (
  modifierId: number,
  values: ModifierAggregateValues,
): Promise<void> => {
  await execute(
    "UPDATE modifiers SET total_uses = ?, usage_count = ? WHERE id = ?",
    [values.total_uses, values.usage_count, modifierId],
  );
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

const aggregateResetSql: Record<ModifierAggregateField, string> = {
  total_uses:
    "total_uses = COALESCE((SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = ?), 0)",
  usage_count:
    "usage_count = (SELECT COUNT(*) FROM modifier_usages WHERE modifier_id = ?)",
};

/** Reset selected modifier aggregate columns from actual usage rows. */
export const resetModifierAggregateFields = async (
  modifierId: number,
  fields: ModifierAggregateField[],
): Promise<void> => {
  await resetAggregates("modifiers", modifierId, fields, aggregateResetSql);
};

/** Run a single-column `id` query for a modifier and return the ids. */
const modifierIdColumn = async (
  sql: string,
  modifierId: number,
): Promise<number[]> => {
  const rows = await queryAll<{ id: number }>(sql, [modifierId]);
  return rows.map((r) => r.id);
};

/** Listing ids a modifier is directly linked to (scope = "listings"). */
export const getModifierListingIds = (modifierId: number): Promise<number[]> =>
  modifierIdColumn(
    "SELECT listing_id AS id FROM modifier_listings WHERE modifier_id = ?",
    modifierId,
  );

type ModifierListingLinkRow = { listing_id: number; modifier_id: number };

const emptyModifierScopeMap = (modifierIds: number[]): Map<number, number[]> =>
  new Map(modifierIds.map((id) => [id, []]));

const appendModifierListingLinks = (
  links: Map<number, number[]>,
  rows: ModifierListingLinkRow[],
): Map<number, number[]> => {
  for (const row of rows) {
    links.get(row.modifier_id)!.push(row.listing_id);
  }
  return links;
};

/** Build a batched modifier->listing scope lookup: the returned function runs
 * `buildSql` (given the bound `IN (...)` placeholders) and buckets the rows by
 * modifier id. */
const modifierScopeListingIdsLookup =
  (buildSql: (placeholders: string) => string) =>
  async (modifierIds: number[]): Promise<Map<number, number[]>> => {
    if (modifierIds.length === 0) return new Map();
    const rows = await queryAll<ModifierListingLinkRow>(
      buildSql(inPlaceholders(modifierIds)),
      modifierIds,
    );
    return appendModifierListingLinks(emptyModifierScopeMap(modifierIds), rows);
  };

/** Listing ids directly linked to each listing-scoped modifier id. */
export const getModifierListingIdsByModifierId = modifierScopeListingIdsLookup(
  (placeholders) =>
    `SELECT modifier_id, listing_id FROM modifier_listings
     WHERE modifier_id IN (${placeholders})`,
);

/** Listing ids belonging to linked groups for each group-scoped modifier id. */
export const getModifierGroupListingIdsByModifierId =
  modifierScopeListingIdsLookup(
    (placeholders) =>
      `SELECT modifierGroup.modifier_id, listing.id AS listing_id
       FROM modifier_groups AS modifierGroup
         JOIN listings AS listing ON listing.group_id = modifierGroup.group_id
       WHERE modifierGroup.modifier_id IN (${placeholders})`,
  );

/** Group ids a modifier is linked to (for the admin scope editor). */
export const getModifierGroupIds = (modifierId: number): Promise<number[]> =>
  modifierIdColumn(
    "SELECT group_id AS id FROM modifier_groups WHERE modifier_id = ?",
    modifierId,
  );

/** Answer ids an "answer"-triggered modifier is linked to (for the admin
 * editor) — i.e. the answers whose modifier_id points at this modifier. */
export const getModifierAnswerIds = (modifierId: number): Promise<number[]> =>
  modifierIdColumn("SELECT id FROM answers WHERE modifier_id = ?", modifierId);

/** Run a "clear, then re-add" batch idempotently: one reset statement (bound to
 * `[modifierId]`), then one write per id (bound to `[modifierId, id]`). Shared
 * by every modifier-link save whether the links live in a join table (insert a
 * row per id) or a column on the target rows (update them), so the batch shape
 * lives in one place. */
const resetAndWriteLinks = (
  resetSql: string,
  writeSql: string,
  modifierId: number,
  ids: number[],
): Promise<unknown> =>
  executeBatch([
    { args: [modifierId], sql: resetSql },
    ...ids.map((id) => ({ args: [modifierId, id], sql: writeSql })),
  ]);

/** Replace a modifier's link rows in `table` with one per id (reset + insert),
 * so saving the scope editor is idempotent. */
const setModifierLinks = (
  table: "modifier_listings" | "modifier_groups",
  column: "listing_id" | "group_id",
  modifierId: number,
  ids: number[],
): Promise<unknown> =>
  resetAndWriteLinks(
    `DELETE FROM ${table} WHERE modifier_id = ?`,
    `INSERT INTO ${table} (modifier_id, ${column}) VALUES (?, ?)`,
    modifierId,
    ids,
  );

/** Set the listings a "listings"-scoped modifier is charged on. */
export const setModifierListings = (
  modifierId: number,
  listingIds: number[],
): Promise<unknown> =>
  setModifierLinks("modifier_listings", "listing_id", modifierId, listingIds);

/** Set the groups a "groups"-scoped modifier is charged on. */
export const setModifierGroups = (
  modifierId: number,
  groupIds: number[],
): Promise<unknown> =>
  setModifierLinks("modifier_groups", "group_id", modifierId, groupIds);

/** Point the given answers at an "answer"-triggered modifier (and clear any
 * answers previously pointing at it), so saving the editor is idempotent and
 * an answer carries at most one modifier. */
export const setModifierAnswers = (
  modifierId: number,
  answerIds: number[],
): Promise<unknown> =>
  resetAndWriteLinks(
    "UPDATE answers SET modifier_id = NULL WHERE modifier_id = ?",
    "UPDATE answers SET modifier_id = ? WHERE id = ?",
    modifierId,
    answerIds,
  );

/** Selected answer id → the "answer"-trigger modifier it activates (as a
 * single-element list, absent when the answer has no modifier), keyed for
 * resolve so a modifier's quantity totals across every chosen answer that
 * points at it. */
export const modifierIdsByAnswerId = async (
  answerIds: number[],
): Promise<Map<number, number[]>> =>
  new Map(
    [
      ...(await columnMapByIds(
        "answers",
        "answer",
        "modifier_id",
        answerIds,
        " AND answer.modifier_id IS NOT NULL",
      )),
    ].map(([id, modifierId]) => [id, [modifierId]]),
  );
