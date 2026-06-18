/**
 * Modifiers table operations.
 *
 * Modifiers are owner-defined price rules (surcharges, discounts, add-ons).
 * There are typically only a handful, they are read on admin pages, and
 * (for now) nothing reads them on the hot public path, so this layer talks to
 * the table directly without a cache.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { executeBatch, queryAll } from "#shared/db/client.ts";
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
  minVisits?: number;
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
    min_visits: col.withDefault(() => 0),
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
