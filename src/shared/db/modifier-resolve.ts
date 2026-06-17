/**
 * Resolve which modifiers apply to a checkout, and rebuild them in the webhook.
 *
 * A modifier's stored `calc_value` is the positive magnitude the owner entered;
 * this layer turns it into the signed value the pricing engine expects (fixed
 * amounts converted from major to minor units, discounts negated, multipliers
 * left as the literal factor). The webhook re-fetches modifiers by id and
 * rebuilds the same specs, so provider metadata amounts are never trusted.
 */

import { compact } from "#fp";
import { itemsSubtotal } from "#shared/booking-fee.ts";
import { toMinorUnits } from "#shared/currency.ts";
import {
  getVisits,
  hashEmail,
  hashPhone,
} from "#shared/db/contact-preferences.ts";
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
  itemsSubtotal(
    listingIds === null
      ? items
      : items.filter((i) => listingIds.includes(i.listingId)),
  );

/** A modifier eligible by scope and minimum subtotal (stock checked after). */
type Candidate = { modifier: Modifier; listingIds: number[] | null };

/** Whether a stock-limited modifier still has a unit left. */
const hasStock = (modifier: Modifier, used: Map<number, number>): boolean =>
  modifier.stock === null || modifier.stock - (used.get(modifier.id) ?? 0) >= 1;

/**
 * Pricing context for resolving automatic modifiers: the buyer's keyless visit
 * count (their prior bookings), used to gate a returning-customer discount.
 * Defaults to 0 (a first-time / unknown buyer), so an absent context behaves as
 * "no prior bookings".
 */
export type PricingContext = { visits: number };

/** Context for a buyer we know nothing about (no prior bookings). */
const NO_VISITS: PricingContext = { visits: 0 };

/**
 * The buyer's visit count, read keyless from contact_preferences by hashing the
 * email/phone they entered on the form. Takes the max across the identifiers
 * present (a buyer who gave both gets the higher recognition); 0 when neither is
 * present or neither has been seen before. Re-derived server-side at the
 * authoritative pricing point so a crafted checkout can't claim returning
 * status.
 */
export const buyerVisits = async (
  email?: string,
  phone?: string,
): Promise<number> => {
  // Tolerate non-string / blank identifiers: provider metadata is adversarial
  // input, so a malformed value is treated as absent rather than throwing (the
  // same robustness createAttendeeAtomic applies before hashing).
  const usable = (v: string | undefined): v is string =>
    typeof v === "string" && v.trim() !== "";
  const hashes = await Promise.all(
    compact([
      usable(email) ? hashEmail(email) : null,
      usable(phone) ? hashPhone(phone) : null,
    ]),
  );
  if (hashes.length === 0) return 0;
  const counts = await Promise.all(hashes.map(getVisits));
  return Math.max(0, ...counts);
};

/**
 * The modifiers that automatically apply to a cart: active, automatic, in
 * scope, past their minimum subtotal and minimum visit count, and with stock
 * remaining. The visit gate (`min_visits`) reads the buyer's prior-booking
 * count from `ctx`, exactly parallel to the `min_subtotal` gate.
 */
export const resolveModifiers = async (
  items: CheckoutItem[],
  ctx: PricingContext = NO_VISITS,
): Promise<ModifierSpec[]> => {
  const automatic = (await getActiveModifiers())
    .filter((m) => m.trigger === "automatic")
    // Drop modifiers that need more prior bookings than this buyer has, the
    // same shape of gate as min_subtotal below.
    .filter((m) => m.min_visits <= ctx.visits);
  const candidates = (
    await Promise.all(
      automatic.map(async (modifier): Promise<Candidate | null> => {
        const listingIds = await listingIdsFor(modifier);
        const base = inScopeSubtotal(items, listingIds);
        // A scoped modifier only applies alongside its listings/groups.
        if (listingIds !== null && base === 0) return null;
        return base >= modifier.min_subtotal ? { listingIds, modifier } : null;
      }),
    )
  ).filter((c): c is Candidate => c !== null);

  // One batched usage lookup for every stock-limited candidate.
  const used = await modifierUsedQuantities(
    candidates
      .filter((c) => c.modifier.stock !== null)
      .map((c) => c.modifier.id),
  );
  return candidates
    .filter((c) => hasStock(c.modifier, used))
    .map((c) => toSpec(c.modifier, 1, c.listingIds));
};

/**
 * Rebuild modifier specs from the references stored in session metadata,
 * re-fetching each modifier's current values (and scope) from the database.
 * References to modifiers that have since been removed or deactivated are
 * dropped (the webhook then sees a total mismatch and refunds).
 *
 * `ctx` carries the buyer's visit count, re-read server-side in the webhook so
 * the `min_visits` gate is honoured against a trusted count rather than the
 * provider metadata: a crafted checkout that references a returning-customer
 * discount the buyer doesn't qualify for has that ref dropped here, so the
 * re-resolved total no longer matches and the existing mismatch-refund path
 * fires. Defaults to 0 visits (a first-time buyer), so any visit-gated modifier
 * is excluded unless the buyer is genuinely returning.
 */
export const specsFromRefs = async (
  refs: ModifierRef[],
  ctx: PricingContext = NO_VISITS,
): Promise<ModifierSpec[]> => {
  if (refs.length === 0) return [];
  const byId = new Map((await getActiveModifiers()).map((m) => [m.id, m]));
  const specs = await Promise.all(
    refs.map(async (ref) => {
      const modifier = byId.get(ref.i);
      // Re-check the visit gate server-side; a metadata ref can't unlock a
      // returning-customer modifier for a buyer who isn't returning.
      if (!modifier || modifier.min_visits > ctx.visits) return null;
      return toSpec(modifier, ref.q, await listingIdsFor(modifier));
    }),
  );
  return specs.filter((s): s is ModifierSpec => s !== null);
};
