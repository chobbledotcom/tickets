/**
 * Modifiers table operations.
 *
 * Modifiers are owner-defined price rules (surcharges, discounts, add-ons).
 * There are typically only a handful, they are read on admin pages, and
 * (for now) nothing reads them on the hot public path, so this layer talks to
 * the table directly without a cache.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  executeBatch,
  getDb,
  queryAll,
  queryOne,
  resetAggregates,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
} from "#shared/db/common-schema.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { col } from "#shared/db/table.ts";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";

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
  scope?: ModifierScope;
  minSubtotal?: number;
  stock?: number | null;
};

/** Modifiers table with CRUD operations. Name is encrypted at rest, matching
 * the other owner-defined entities. Behavioural columns (active, trigger,
 * scope, min_subtotal) have sensible defaults so the base create form need
 * only supply the pricing rule; later admin fields populate the rest. */
export const modifiersTable = defineIdTable<Modifier, ModifierInput>(
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
    scope: col.withDefault<ModifierScope>(() => "all"),
    stock: col.withDefault<number | null>(() => null),
    // Trigger-maintained aggregates over modifier_usages — read-only here
    // (generated), so insert/update never write them and the DB default / the
    // triggers keep them current.
    total_revenue: col.generated<number>(),
    total_uses: col.generated<number>(),
    trigger: col.withDefault<ModifierTrigger>(() => "automatic"),
    usage_count: col.generated<number>(),
  },
);

/** Execute a query and decrypt the resulting modifier rows. */
const queryModifiers = queryAndMap<Modifier, Modifier>((row) =>
  modifiersTable.fromDb(row),
);

/** Get all modifiers, decrypted, ordered by id. */
export const getAllModifiers = (): Promise<Modifier[]> =>
  queryModifiers("SELECT * FROM modifiers ORDER BY id ASC");

/** Get the active modifiers, decrypted, ordered by id. */
export const getActiveModifiers = (): Promise<Modifier[]> =>
  queryModifiers("SELECT * FROM modifiers WHERE active = 1 ORDER BY id ASC");

export const MODIFIER_AGGREGATE_FIELDS = [
  "total_uses",
  "usage_count",
  "total_revenue",
] as const;

export type ModifierAggregateField = (typeof MODIFIER_AGGREGATE_FIELDS)[number];

export type ModifierAggregateValues = Record<ModifierAggregateField, number>;

export type ModifierAggregateRecalculation = Record<
  ModifierAggregateField,
  { current: number; recalculated: number }
>;

/** The modifier aggregate columns as they would be if rebuilt from usage rows. */
export const getModifierAggregateRecalculation = async (
  modifier: Modifier,
): Promise<ModifierAggregateRecalculation> => {
  const row = (await queryOne<ModifierAggregateValues>(
    `SELECT
       COALESCE(SUM(quantity), 0) AS total_uses,
       COUNT(*) AS usage_count,
       COALESCE(SUM(amount_applied), 0) AS total_revenue
     FROM modifier_usages
     WHERE modifier_id = ?`,
    [modifier.id],
  ))!;
  return {
    total_revenue: {
      current: modifier.total_revenue,
      recalculated: row.total_revenue,
    },
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
  await getDb().execute({
    args: [
      values.total_uses,
      values.usage_count,
      values.total_revenue,
      modifierId,
    ],
    sql: "UPDATE modifiers SET total_uses = ?, usage_count = ?, total_revenue = ? WHERE id = ?",
  });
};

const aggregateResetSql: Record<ModifierAggregateField, string> = {
  total_revenue:
    "total_revenue = COALESCE((SELECT SUM(amount_applied) FROM modifier_usages WHERE modifier_id = ?), 0)",
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

/** Listing ids belonging to the groups a modifier is linked to (scope = "groups"). */
export const getModifierGroupListingIds = (
  modifierId: number,
): Promise<number[]> =>
  modifierIdColumn(
    `SELECT e.id FROM listings e
       JOIN modifier_groups mg ON mg.group_id = e.group_id
     WHERE mg.modifier_id = ?`,
    modifierId,
  );

/** Group ids a modifier is linked to (for the admin scope editor). */
export const getModifierGroupIds = (modifierId: number): Promise<number[]> =>
  modifierIdColumn(
    "SELECT group_id AS id FROM modifier_groups WHERE modifier_id = ?",
    modifierId,
  );

/** Replace a modifier's link rows in `table` with one per id (reset + insert),
 * so saving the scope editor is idempotent. */
const setModifierLinks = (
  table: "modifier_listings" | "modifier_groups",
  column: "listing_id" | "group_id",
  modifierId: number,
  ids: number[],
): Promise<unknown> =>
  executeBatch([
    {
      args: [modifierId],
      sql: `DELETE FROM ${table} WHERE modifier_id = ?`,
    },
    ...ids.map((id) => ({
      args: [modifierId, id],
      sql: `INSERT INTO ${table} (modifier_id, ${column}) VALUES (?, ?)`,
    })),
  ]);

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
