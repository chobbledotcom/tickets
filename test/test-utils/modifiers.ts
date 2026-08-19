import { expect } from "@std/expect";
import { getDb } from "#db/client.ts";
import {
  getAllModifiers,
  type ModifierInput,
  modifiersTable,
} from "#db/modifiers.ts";

/** Insert a modifier through the production table, defaulting to a £5 charge. */
export const insertModifier = (overrides: Partial<ModifierInput> = {}) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
    ...overrides,
  });

/** Set behavioural columns the base create form doesn't expose (trigger,
 * scope, stock, code_index, active, min_visits, …). */
export const patchModifier = (
  id: number,
  set: Record<string, string | number>,
) => {
  const cols = Object.keys(set);
  const assignments = cols.map((c) => `${c} = ?`).join(", ");
  return getDb().execute({
    args: [...cols.map((c) => set[c]!), id],
    sql: `UPDATE modifiers SET ${assignments} WHERE id = ?`,
  });
};

/** Link a "listings"-scoped modifier to a listing. */
export const linkModifierListing = (modifierId: number, listingId: number) =>
  getDb().execute({
    args: [modifierId, listingId],
    sql: "INSERT INTO modifier_listings (modifier_id, listing_id) VALUES (?, ?)",
  });

/** Insert an active opt-in add-on scoped to the given listing ids. */
export const optInAddOnForListings = async (
  name: string,
  listingIds: number[],
): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, { scope: "listings", trigger: "optional" });
  for (const listingId of listingIds) {
    await linkModifierListing(modifier.id, listingId);
  }
};

/** Link a "groups"-scoped modifier to a group. */
export const linkModifierGroup = (modifierId: number, groupId: number) =>
  getDb().execute({
    args: [modifierId, groupId],
    sql: "INSERT INTO modifier_groups (modifier_id, group_id) VALUES (?, ?)",
  });

/** Point a question answer at an "answer"-triggered modifier. */
export const linkModifierAnswer = (modifierId: number, answerId: number) =>
  getDb().execute({
    args: [modifierId, answerId],
    sql: "UPDATE answers SET modifier_id = ? WHERE id = ?",
  });

/** Insert a `modifier_usages` row directly, bypassing the checkout flow —
 *  used by both the modifier-aggregates and server-modifiers test suites to
 *  set up aggregate state without going through a full booking. */
export const insertModifierUsage = (
  modifierId: number,
  attendeeId: number,
  quantity: number,
  amountApplied: number,
): Promise<unknown> =>
  getDb().execute({
    args: [modifierId, attendeeId, quantity, amountApplied, "2026-06-17"],
    sql: "INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (?, ?, ?, ?, ?)",
  });

/** Sum a `modifier_usages` column across a modifier's recorded rows — safe
 *  for one, many, or no rows (no usage sums to 0). */
const modifierUsageSum =
  (column: "quantity" | "amount_applied") =>
  async (modifierId: number): Promise<number> => {
    const { rows } = await getDb().execute({
      args: [modifierId],
      sql: `SELECT COALESCE(SUM(modifierUsage.${column}), 0) AS total FROM modifier_usages AS modifierUsage WHERE modifierUsage.modifier_id = ?`,
    });
    return Number(rows[0]!.total);
  };

/** Total quantity recorded against a modifier by a webhook/checkout. */
export const modifierUsageCount = modifierUsageSum("quantity");

/** Total `amount_applied` recorded against a modifier by a webhook/checkout. */
export const modifierUsageAmount = modifierUsageSum("amount_applied");

/**
 * total_revenue is projected from the transfers ledger as balanceOf(modifier)
 * (read directly: a surcharge nets positive, a discount negative), so read it
 * through getAllModifiers — the loader that selects the projection — rather
 * than off the dropped column. The counts stay trigger-maintained.
 */
export const modifierAggregates = async (
  modifierId: number,
): Promise<{
  totalRevenue: number;
  totalUses: number;
  usageCount: number;
}> => {
  const row = (await getAllModifiers()).find((m) => m.id === modifierId)!;
  return {
    totalRevenue: row.total_revenue,
    totalUses: row.total_uses,
    usageCount: row.usage_count,
  };
};

/** Assert a modifier's recorded usage amount and aggregate totals in one
 *  call — the pair of checks every scoped/grouped/promo-code modifier webhook
 *  test ends with, varying only the numbers. */
export const expectModifierUsage = async (
  modifierId: number,
  usageAmount: number,
  aggregates: { totalRevenue: number; totalUses: number; usageCount: number },
): Promise<void> => {
  expect(await modifierUsageAmount(modifierId)).toBe(usageAmount);
  expect(await modifierAggregates(modifierId)).toEqual(aggregates);
};
