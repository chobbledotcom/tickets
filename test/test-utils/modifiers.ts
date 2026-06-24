import { getDb } from "#shared/db/client.ts";
import { type ModifierInput, modifiersTable } from "#shared/db/modifiers.ts";
import type { CheckoutItem } from "#shared/payments.ts";

/** A checkout line item with sensible defaults for pricing/modifier tests. */
export const checkoutItem = (
  overrides: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

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
