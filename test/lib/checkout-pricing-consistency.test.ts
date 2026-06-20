import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb } from "#shared/db/client.ts";
import {
  answerModifierQuantities,
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { answersTable, questionsTable } from "#shared/db/questions.ts";
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
  linkModifierAnswer,
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

/** Create a real question answer and return its id. The answer→modifier link is
 * a column on the answers row, so the answer must actually exist for the link
 * (and the resolve that reads it back) to take effect. */
const createAnswer = async (): Promise<number> => {
  const q = await questionsTable.insert({ displayType: "radio", text: "Q?" });
  const a = await answersTable.insert({
    questionId: q.id,
    sortOrder: 0,
    text: "A",
  });
  return a.id;
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

    test("listing-scoped modifier resolution batches scope links", async () => {
      const modifiers = await Promise.all(
        [1, 2, 3].map(async (listingId) => {
          const m = await insertModifier({
            calcKind: "fixed",
            calcValue: 1,
            direction: "charge",
            name: `Scope ${listingId}`,
          });
          await patchModifier(m.id, { scope: "listings" });
          await linkModifierListing(m.id, listingId);
          return m;
        }),
      );

      const { scopeQueries, specs } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const specs = await resolveModifiers([checkoutItem({ listingId: 1 })]);
        return {
          scopeQueries: getQueryLog().filter((entry) =>
            entry.sql.includes("FROM modifier_listings"),
          ),
          specs,
        };
      });

      expect(specs.map((s) => s.id)).toEqual([modifiers[0]!.id]);
      expect(scopeQueries).toHaveLength(1);
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

    test("an answer-triggered modifier round-trips through metadata refs like an add-on", async () => {
      // A pricing-tier modifier wired to a question answer.
      const answerId = await createAnswer();
      const tier = await insertModifier({
        calcKind: "fixed",
        calcValue: 3,
        direction: "charge",
        name: "Premium answer",
      });
      await patchModifier(tier.id, { trigger: "answer" });
      await linkModifierAnswer(tier.id, answerId);

      const items = [checkoutItem({ quantity: 2 })];
      // The buyer picked the linked answer on both tickets of listing 1.
      const publicSpecs = await resolveModifiers(items, {
        answerQuantities: await answerModifierQuantities(
          { "1": [answerId] },
          new Map([[1, 2]]),
        ),
      });
      expect(publicSpecs.map((s) => s.trigger)).toEqual(["answer"]);
      // Carried in the refs by id+quantity, exactly like every other trigger.
      expect(toModifierRefs(publicSpecs)).toEqual([{ i: tier.id, q: 2 }]);

      await expectConsistent(items, publicSpecs);
    });

    test("a stock-clamped answer modifier re-prices on its clamped quantity", async () => {
      // Selecting the answer on 5 tickets, but only 2 in stock: the resolve
      // clamps the quantity to 2 and that clamped count is what the refs carry,
      // so the webhook re-prices the same total instead of refunding a good
      // order on a phantom mismatch.
      const answerId = await createAnswer();
      const tier = await insertModifier({
        calcKind: "fixed",
        calcValue: 3,
        direction: "charge",
        name: "Limited tier",
        stock: 2,
      });
      await patchModifier(tier.id, { trigger: "answer" });
      await linkModifierAnswer(tier.id, answerId);

      const items = [checkoutItem({ quantity: 5 })];
      const publicSpecs = await resolveModifiers(items, {
        answerQuantities: await answerModifierQuantities(
          { "1": [answerId] },
          new Map([[1, 5]]),
        ),
      });
      expect(publicSpecs.find((s) => s.trigger === "answer")?.quantity).toBe(2);
      expect(toModifierRefs(publicSpecs)).toEqual([{ i: tier.id, q: 2 }]);

      await expectConsistent(items, publicSpecs);
    });

    test("property: random modifier mixes re-price identically on both paths", async () => {
      // A repeatable PRNG so a failure is reproducible from the seed.
      let seed = 0x5eed1234;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const randInt = (lo: number, hi: number) =>
        lo + Math.floor(rand() * (hi - lo + 1));
      const db = getDb();

      for (let iter = 0; iter < 40; iter++) {
        // Each iteration is an independent cart + modifier set.
        await db.execute("DELETE FROM modifier_usages");
        await db.execute("DELETE FROM modifiers");

        const items = Array.from({ length: randInt(1, 3) }, (_, i) =>
          checkoutItem({
            listingId: i + 1,
            quantity: randInt(1, 3),
            slug: `gen-${i}`,
            unitPrice: randInt(10, 60) * 100,
          }),
        );

        const addOns = new Map<number, number>();
        let code: string | undefined;
        for (let m = 0; m < randInt(0, 4); m++) {
          const kind = pick(["fixed", "percent", "multiply"] as const);
          const inserted = await insertModifier({
            calcKind: kind,
            calcValue:
              kind === "multiply"
                ? pick([1.25, 1.5, 2])
                : kind === "percent"
                  ? randInt(5, 25)
                  : randInt(1, 5),
            direction: pick(["charge", "discount"] as const),
            name: `gen-${iter}-${m}`,
            stock: pick([null, 5]),
          });
          const trigger = pick(["automatic", "optional", "code"] as const);
          const patch: Record<string, string | number> = {
            min_visits: pick([0, 0, 1]),
            trigger,
          };
          if (trigger === "optional") addOns.set(inserted.id, randInt(1, 3));
          if (trigger === "code") {
            code = "PROMO";
            patch.code_index = await hmacHash(normalizeCode("PROMO"));
          }
          await patchModifier(inserted.id, patch);
        }

        const ctx = { visits: randInt(0, 2) };
        const specs = await resolveModifiers(items, { addOns, code, ctx });
        await expectConsistent(items, specs, { ctx });
      }
    });
  },
);
