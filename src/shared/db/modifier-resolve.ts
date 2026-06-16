/**
 * Resolve which modifiers apply to a checkout, and rebuild them in the webhook.
 *
 * A modifier's stored `calc_value` is the positive magnitude the owner entered;
 * this layer turns it into the signed value the pricing engine expects (fixed
 * amounts converted from major to minor units, discounts negated, multipliers
 * left as the literal factor). The webhook re-fetches modifiers by id and
 * rebuilds the same specs, so provider metadata amounts are never trusted.
 */

import { sumOf } from "#fp";
import { toMinorUnits } from "#shared/currency.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import {
  getActiveModifiers,
  getModifierGroupListingIds,
  getModifierListingIds,
} from "#shared/db/modifiers.ts";
import type {
  CheckoutItem,
  ModifierRef,
  ModifierSpec,
} from "#shared/payments.ts";
import type { Modifier } from "#shared/types.ts";

/** The signed pricing value the engine applies, from a modifier's stored
 * magnitude + direction. Multipliers ignore direction (the factor encodes it);
 * fixed amounts are entered in major currency units and stored as such. */
const signedValue = (modifier: Modifier): number => {
  if (modifier.calc_kind === "multiply") return modifier.calc_value;
  const magnitude =
    modifier.calc_kind === "fixed"
      ? toMinorUnits(modifier.calc_value)
      : modifier.calc_value;
  return modifier.direction === "discount" ? -magnitude : magnitude;
};

/** The listing ids a modifier is charged on, or null for the whole order. */
const listingIdsFor = (modifier: Modifier): Promise<number[]> | null => {
  if (modifier.scope === "groups")
    return getModifierGroupListingIds(modifier.id);
  if (modifier.scope === "listings") return getModifierListingIds(modifier.id);
  return null;
};

/** Build the checkout spec for a modifier applied `quantity` times. */
const toSpec = (
  modifier: Modifier,
  quantity: number,
  listingIds: number[] | null,
): ModifierSpec => ({
  id: modifier.id,
  kind: modifier.calc_kind,
  listingIds,
  name: modifier.name,
  quantity,
  value: signedValue(modifier),
});

/** Subtotal of the items a modifier is scoped to (the whole cart when its
 * listing ids are null), used for the minimum-subtotal and "alongside" checks. */
const inScopeSubtotal = (
  items: CheckoutItem[],
  listingIds: number[] | null,
): number =>
  sumOf((i: CheckoutItem) => i.unitPrice * i.quantity)(
    listingIds === null
      ? items
      : items.filter((i) => listingIds.includes(i.listingId)),
  );

/** Resolve a modifier against a cart into a spec, or null when it does not
 * apply (scoped to items not present, below its minimum, or out of stock). */
const resolveOne = async (
  modifier: Modifier,
  items: CheckoutItem[],
): Promise<ModifierSpec | null> => {
  const listingIds = await listingIdsFor(modifier);
  const base = inScopeSubtotal(items, listingIds);
  // A scoped modifier only applies alongside its listings/groups.
  if (listingIds !== null && base === 0) return null;
  if (base < modifier.min_subtotal) return null;
  if (modifier.stock !== null) {
    const used = await modifierUsedQuantities([modifier.id]);
    if (modifier.stock - (used.get(modifier.id) ?? 0) < 1) return null;
  }
  return toSpec(modifier, 1, listingIds);
};

/**
 * The modifiers that automatically apply to a cart: active, automatic, in
 * scope, past their minimum subtotal, and with stock remaining.
 */
export const resolveModifiers = async (
  items: CheckoutItem[],
): Promise<ModifierSpec[]> => {
  const automatic = (await getActiveModifiers()).filter(
    (m) => m.trigger === "automatic",
  );
  const resolved = await Promise.all(
    automatic.map((m) => resolveOne(m, items)),
  );
  return resolved.filter((s): s is ModifierSpec => s !== null);
};

/**
 * Rebuild modifier specs from the references stored in session metadata,
 * re-fetching each modifier's current values (and scope) from the database.
 * References to modifiers that have since been removed or deactivated are
 * dropped (the webhook then sees a total mismatch and refunds).
 */
export const specsFromRefs = async (
  refs: ModifierRef[],
): Promise<ModifierSpec[]> => {
  if (refs.length === 0) return [];
  const byId = new Map((await getActiveModifiers()).map((m) => [m.id, m]));
  const specs = await Promise.all(
    refs.map(async (ref) => {
      const modifier = byId.get(ref.i);
      return modifier
        ? toSpec(modifier, ref.q, await listingIdsFor(modifier))
        : null;
    }),
  );
  return specs.filter((s): s is ModifierSpec => s !== null);
};
