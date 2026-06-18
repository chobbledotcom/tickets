import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import {
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import { toModifierRefs } from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierRef,
  ModifierSpec,
} from "#shared/payments.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import {
  checkoutItem,
  describeWithEnv,
  insertModifier,
  linkModifierListing,
  patchModifier,
  useSetting,
} from "#test-utils";

/**
 * The public checkout and the webhook must price the same cart identically: the
 * buyer is charged the total the public pricing computed, and on payment the
 * webhook re-derives that total from session metadata and refunds on a
 * mismatch. The two paths share priceCheckout but resolve modifiers
 * differently — resolveModifiers (live, by scope/code/stock) up front vs
 * specsFromRefs (re-fetched by id) on completion — so a divergence between them
 * silently refunds good orders. These tests pin the round-trip:
 *
 *   resolveModifiers → toModifierRefs → (metadata JSON) → specsFromRefs
 *
 * must land on the same priced total and modifier applications.
 */

const buyer = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

const pricingIntent = (
  items: CheckoutItem[],
  modifiers: ModifierSpec[],
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent => ({
  ...buyer,
  date: null,
  items,
  modifiers,
  ...overrides,
});

/** Reproduce the webhook's modifier rebuild: compact the resolved specs to the
 * id/quantity refs stored in provider metadata, pass them through the JSON
 * boundary the webhook parses, then re-fetch by id — exactly as production. */
const rebuildFromMetadata = async (
  publicSpecs: ModifierSpec[],
  ctx: { visits: number } = { visits: 0 },
): Promise<ModifierSpec[]> => {
  const refs = toModifierRefs(publicSpecs) ?? [];
  const fromMetadata = JSON.parse(JSON.stringify(refs)) as ModifierRef[];
  return specsFromRefs(fromMetadata, ctx);
};

/** Assert the public specs and their webhook-rebuilt counterparts price a cart
 * to the same total and the same applications. */
const expectConsistent = async (
  items: CheckoutItem[],
  publicSpecs: ModifierSpec[],
  opts: { ctx?: { visits: number }; overrides?: Partial<CheckoutIntent> } = {},
): Promise<void> => {
  const ctx = opts.ctx ?? { visits: 0 };
  const webhookSpecs = await rebuildFromMetadata(publicSpecs, ctx);
  const pub = priceCheckout(pricingIntent(items, publicSpecs, opts.overrides));
  const web = priceCheckout(pricingIntent(items, webhookSpecs, opts.overrides));
  expect(web.total).toBe(pub.total);
  expect(web.modifierApplications).toEqual(pub.modifierApplications);
};

describeWithEnv(
  "checkout pricing consistency (public ↔ webhook)",
  { db: true },
  () => {
    // Zero the booking fee so totals are pure modifier math; the fee is equal on
    // both paths regardless, but this keeps the cases easy to reason about.
    useSetting({ booking_fee: "0" });

    test("a whole-order fixed surcharge re-prices identically", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const items = [checkoutItem({ quantity: 2 })];
      const specs = await resolveModifiers(items);
      expect(specs).toHaveLength(1);
      await expectConsistent(items, specs);
    });

    test("a percentage discount keeps its negative value through the round-trip", async () => {
      await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "Loyalty",
      });
      const items = [checkoutItem({ quantity: 3 })];
      const specs = await resolveModifiers(items);
      expect(specs[0]!.value).toBe(-10);
      await expectConsistent(items, specs);
    });

    test("a multiplier re-prices identically", async () => {
      await insertModifier({
        calcKind: "multiply",
        calcValue: 1.5,
        direction: "charge",
        name: "Peak",
      });
      const items = [checkoutItem()];
      const specs = await resolveModifiers(items);
      expect(specs[0]!.value).toBe(1.5);
      await expectConsistent(items, specs);
    });

    test("a listing-scoped modifier rebuilds its listing ids (which refs don't store)", async () => {
      const m = await insertModifier({
        calcKind: "percent",
        calcValue: 20,
        direction: "charge",
        name: "VIP",
      });
      await patchModifier(m.id, { scope: "listings" });
      await linkModifierListing(m.id, 1);
      const items = [checkoutItem({ listingId: 1 })];
      const specs = await resolveModifiers(items);
      expect(specs[0]!.listingIds).toEqual([1]);
      await expectConsistent(items, specs);
    });

    test("a code modifier is re-applied on the webhook without re-entering the code", async () => {
      const m = await insertModifier({
        calcKind: "fixed",
        calcValue: 8,
        direction: "charge",
        name: "SUMMER",
      });
      await patchModifier(m.id, {
        code_index: await hmacHash(normalizeCode("Summer25")),
        trigger: "code",
      });
      const items = [checkoutItem()];
      const specs = await resolveModifiers(items, { code: "SUMMER25" });
      expect(specs.map((s) => s.name)).toEqual(["SUMMER"]);
      await expectConsistent(items, specs);
    });

    test("an opt-in add-on keeps its chosen quantity", async () => {
      const m = await insertModifier({
        calcKind: "fixed",
        calcValue: 4,
        direction: "charge",
        name: "T-shirt",
      });
      await patchModifier(m.id, { trigger: "optional" });
      const items = [checkoutItem()];
      const specs = await resolveModifiers(items, {
        addOns: new Map([[m.id, 3]]),
      });
      expect(specs[0]!.quantity).toBe(3);
      await expectConsistent(items, specs);
    });

    test("a stock-clamped add-on charges the clamped quantity, not the requested one", async () => {
      const m = await insertModifier({
        calcKind: "fixed",
        calcValue: 4,
        direction: "charge",
        name: "Limited tee",
        stock: 2,
      });
      await patchModifier(m.id, { trigger: "optional" });
      const items = [checkoutItem()];
      const specs = await resolveModifiers(items, {
        addOns: new Map([[m.id, 5]]),
      });
      // Resolution clamped 5 → 2; the webhook must re-price the clamped 2.
      expect(specs[0]!.quantity).toBe(2);
      await expectConsistent(items, specs);
    });

    test("a visit-gated modifier re-prices identically for the same visit count", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "discount",
        minVisits: 1,
        name: "Welcome back",
      });
      const items = [checkoutItem()];
      const specs = await resolveModifiers(items, { ctx: { visits: 2 } });
      expect(specs).toHaveLength(1);
      await expectConsistent(items, specs, { ctx: { visits: 2 } });
    });

    test("several modifiers on a multi-item cart re-price identically", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "Loyalty",
      });
      const scoped = await insertModifier({
        calcKind: "percent",
        calcValue: 25,
        direction: "charge",
        name: "VIP",
      });
      await patchModifier(scoped.id, { scope: "listings" });
      await linkModifierListing(scoped.id, 2);
      const items = [
        checkoutItem({ listingId: 1, quantity: 2, unitPrice: 1000 }),
        checkoutItem({
          listingId: 2,
          quantity: 1,
          slug: "vip",
          unitPrice: 5000,
        }),
      ];
      const specs = await resolveModifiers(items);
      expect(specs).toHaveLength(3);
      await expectConsistent(items, specs);
    });

    test("a reservation deposit combined with a modifier re-prices identically", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const items = [checkoutItem({ quantity: 2 })];
      const specs = await resolveModifiers(items);
      expect(specs).toHaveLength(1);
      await expectConsistent(items, specs, {
        overrides: { reservationAmount: "10%" },
      });
    });

    test("an answer modifier whose id collides with an active modifier is not re-applied as that modifier", async () => {
      // An active opt-in add-on the buyer did NOT select, so resolveModifiers
      // skips it for this cart. specsFromRefs does not re-check the opt-in
      // trigger, so a metadata ref carrying this id would wrongly revive it.
      const addOn = await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Unselected add-on",
      });
      await patchModifier(addOn.id, { trigger: "optional" });

      // An answer price modifier the buyer DID pick, sharing the add-on's id
      // (answer ids and modifier ids autoincrement in separate tables, so low
      // ids collide). The webhook re-derives answer specs from answer_ids, not
      // from modifier refs, so the add-on's id must never leak into the refs.
      const answerSpec: ModifierSpec = {
        id: addOn.id,
        kind: "fixed",
        listingIds: null,
        name: "Premium answer",
        quantity: 1,
        source: "answer",
        trigger: "automatic",
        value: toMinorUnits(3),
      };
      const items = [checkoutItem()];

      // Public total: just the +£3 answer. Add-on was not selected.
      const publicSpecs = [answerSpec];
      const publicTotal = priceCheckout(
        pricingIntent(items, publicSpecs),
      ).total;

      // Webhook: real modifiers come from the refs, answers are re-added from
      // answer_ids. The unselected add-on must not reappear via the refs.
      const refs = toModifierRefs(publicSpecs) ?? [];
      const fromMetadata = JSON.parse(JSON.stringify(refs)) as ModifierRef[];
      const webhookModifiers = await specsFromRefs(fromMetadata);
      const webhookSpecs = [...webhookModifiers, answerSpec];
      const webhookTotal = priceCheckout(
        pricingIntent(items, webhookSpecs),
      ).total;

      expect(webhookTotal).toBe(publicTotal);
    });
  },
);
