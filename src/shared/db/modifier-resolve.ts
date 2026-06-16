/**
 * Resolve which modifiers apply to a checkout, and rebuild them in the webhook.
 *
 * A modifier's stored `calc_value` is the positive magnitude the owner entered;
 * this layer turns it into the signed value the pricing engine expects (fixed
 * amounts converted from major to minor units, discounts negated, multipliers
 * left as the literal factor). The webhook re-fetches modifiers by id and
 * rebuilds the same specs, so provider metadata amounts are never trusted.
 */

import { mapNotNullish, sumOf } from "#fp";
import { toMinorUnits } from "#shared/currency.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { getActiveModifiers } from "#shared/db/modifiers.ts";
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

/** Build the checkout spec for a modifier applied `quantity` times. */
const toSpec = (modifier: Modifier, quantity: number): ModifierSpec => ({
  id: modifier.id,
  kind: modifier.calc_kind,
  listingIds: null,
  name: modifier.name,
  quantity,
  value: signedValue(modifier),
});

/** Sum of the full (pre-modifier) item prices in a cart. */
const itemsSubtotal = (items: CheckoutItem[]): number =>
  sumOf((i: CheckoutItem) => i.unitPrice * i.quantity)(items);

/**
 * The modifiers that automatically apply to a cart: active, whole-order, and
 * past their minimum subtotal. (Code and listing/group-scoped modifiers are
 * resolved by later layers.)
 */
export const resolveModifiers = async (
  items: CheckoutItem[],
): Promise<ModifierSpec[]> => {
  const subtotal = itemsSubtotal(items);
  const active = await getActiveModifiers();
  const eligible = active.filter(
    (m) =>
      m.trigger === "automatic" &&
      m.scope === "all" &&
      subtotal >= m.min_subtotal,
  );
  // Exclude any stock-limited modifier with nothing left (one unit per order).
  const used = await modifierUsedQuantities(
    eligible.filter((m) => m.stock !== null).map((m) => m.id),
  );
  const inStock = (m: Modifier): boolean =>
    m.stock === null || m.stock - (used.get(m.id) ?? 0) >= 1;
  return eligible.filter(inStock).map((m) => toSpec(m, 1));
};

/**
 * Rebuild modifier specs from the references stored in session metadata,
 * re-fetching each modifier's current values from the database. References to
 * modifiers that have since been removed or deactivated are dropped (the
 * webhook then sees a total mismatch and refunds).
 */
export const specsFromRefs = async (
  refs: ModifierRef[],
): Promise<ModifierSpec[]> => {
  if (refs.length === 0) return [];
  const byId = new Map((await getActiveModifiers()).map((m) => [m.id, m]));
  return mapNotNullish((ref: ModifierRef) => {
    const modifier = byId.get(ref.i);
    return modifier ? toSpec(modifier, ref.q) : undefined;
  })(refs);
};
