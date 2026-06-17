/**
 * Resolve which modifiers apply to a checkout, and rebuild them in the webhook.
 *
 * A modifier's stored `calc_value` is the positive magnitude the owner entered;
 * this layer turns it into the signed value the pricing engine expects (fixed
 * amounts converted from major to minor units, discounts negated, multipliers
 * left as the literal factor). The webhook re-fetches modifiers by id and
 * rebuilds the same specs, so provider metadata amounts are never trusted.
 */

import { itemsSubtotal } from "#shared/booking-fee.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { formatCurrency, toMinorUnits } from "#shared/currency.ts";
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
import { normalizeCode } from "#shared/price-modifier.ts";
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

/** A modifier eligible by scope and minimum subtotal, with the quantity the
 * buyer asked for (1 for automatic/code modifiers; the chosen count for an
 * opt-in add-on). Stock is clamped after candidates are gathered. */
type Candidate = {
  modifier: Modifier;
  listingIds: number[] | null;
  quantity: number;
};

/** How many units of a modifier can actually be applied, capping the requested
 * quantity at the remaining stock. Unlimited stock grants the full request. */
const stockedQuantity = (
  modifier: Modifier,
  requested: number,
  used: Map<number, number>,
): number => {
  if (modifier.stock === null) return requested;
  const remaining = modifier.stock - (used.get(modifier.id) ?? 0);
  return Math.max(0, Math.min(requested, remaining));
};

/** How many times a modifier is requested for a cart: automatic modifiers
 * apply once, a "code" modifier applies once when the entered code matches, and
 * an opt-in add-on applies as many times as the buyer chose (0 = not selected).
 * A result below 1 means the modifier doesn't trigger at all. */
const triggerQuantity = (
  modifier: Modifier,
  codeIndex: string | null,
  addOns: Map<number, number>,
): number => {
  if (modifier.trigger === "code")
    return codeIndex !== null && modifier.code_index === codeIndex ? 1 : 0;
  if (modifier.trigger === "optional") return addOns.get(modifier.id) ?? 0;
  return 1;
};

/**
 * The modifiers that apply to a cart: active, triggered, in scope, past their
 * minimum subtotal, and with stock remaining. Automatic modifiers always
 * trigger; a "code" modifier triggers only when the buyer entered its matching
 * code; an "optional" add-on triggers only when the buyer selected it
 * (`opts.addOns` maps modifier id → chosen quantity), and is applied that many
 * times.
 */
export const resolveModifiers = async (
  items: CheckoutItem[],
  opts: { code?: string; addOns?: Map<number, number> } = {},
): Promise<ModifierSpec[]> => {
  const addOns = opts.addOns ?? new Map<number, number>();
  const codeIndex = opts.code?.trim()
    ? await hmacHash(normalizeCode(opts.code))
    : null;
  const candidates = (
    await Promise.all(
      (
        await getActiveModifiers()
      ).map(async (modifier): Promise<Candidate | null> => {
        const quantity = triggerQuantity(modifier, codeIndex, addOns);
        if (quantity < 1) return null;
        const listingIds = await listingIdsFor(modifier);
        const base = inScopeSubtotal(items, listingIds);
        // A scoped modifier only applies alongside its listings/groups.
        if (listingIds !== null && base === 0) return null;
        return base >= modifier.min_subtotal
          ? { listingIds, modifier, quantity }
          : null;
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
    .map((c) => ({
      candidate: c,
      quantity: stockedQuantity(c.modifier, c.quantity, used),
    }))
    .filter(({ quantity }) => quantity >= 1)
    .map(({ candidate, quantity }) =>
      toSpec(candidate.modifier, quantity, candidate.listingIds),
    );
};

/** Whether any active modifier is unlocked by a promo code, so the public
 * order form knows to offer a code field. */
export const hasPromoCodeModifiers = async (): Promise<boolean> =>
  (await getActiveModifiers()).some((m) => m.trigger === "code");

/** Display details for an opt-in add-on offered on the public order form. */
export type AddOnOption = {
  id: number;
  name: string;
  /** Buyer-facing price effect, e.g. "+£5", "−10%", "×1.5". */
  priceLabel: string;
  /** The most units a buyer may select, capped by remaining stock. */
  maxQuantity: number;
};

/** Default ceiling on the add-on quantity selector when stock is unlimited. */
export const ADDON_MAX_QUANTITY = 20;

/** The buyer-facing price label for an add-on: a signed amount or percentage,
 * or a bare multiplier (whose factor already encodes its direction). */
const addOnPriceLabel = (modifier: Modifier): string => {
  if (modifier.calc_kind === "multiply") return `×${modifier.calc_value}`;
  const sign = modifier.direction === "discount" ? "−" : "+";
  const amount =
    modifier.calc_kind === "fixed"
      ? formatCurrency(toMinorUnits(modifier.calc_value))
      : `${modifier.calc_value}%`;
  return `${sign}${amount}`;
};

/**
 * The opt-in add-ons offered for a page's listings: active "optional"
 * modifiers whose scope covers the whole order or overlaps the page, with
 * stock left. Each carries the quantity ceiling the selector should allow.
 */
export const getOptionalAddOns = async (
  pageListingIds: number[],
): Promise<AddOnOption[]> => {
  const optional = (await getActiveModifiers()).filter(
    (m) => m.trigger === "optional",
  );
  const pageIds = new Set(pageListingIds);
  const scoped = (
    await Promise.all(
      optional.map(async (modifier) => {
        const listingIds = await listingIdsFor(modifier);
        const inScope =
          listingIds === null || listingIds.some((id) => pageIds.has(id));
        return inScope ? modifier : null;
      }),
    )
  ).filter((m): m is Modifier => m !== null);
  const used = await modifierUsedQuantities(
    scoped.filter((m) => m.stock !== null).map((m) => m.id),
  );
  return scoped
    .map((modifier) => ({
      maxQuantity: stockedQuantity(modifier, ADDON_MAX_QUANTITY, used),
      modifier,
    }))
    .filter(({ maxQuantity }) => maxQuantity >= 1)
    .map(({ maxQuantity, modifier }) => ({
      id: modifier.id,
      maxQuantity,
      name: modifier.name,
      priceLabel: addOnPriceLabel(modifier),
    }));
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
