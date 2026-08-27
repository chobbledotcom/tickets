import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answerModifierQuantities,
  oversubscribedAnswerTiers,
} from "#db/modifier-resolve.ts";
import { getModifierAnswerIds, setModifierAnswers } from "#db/modifiers.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertModifier,
  insertModifierUsage,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";
import { createAnswers } from "./answer-setup.ts";

/**
 * How a modifier's answer links are stored and read: the quantities the
 * links produce for a cart, and the sold-out tiers they name.
 */
describeWithEnv("modifier-resolve answer links", { db: true }, () => {
  describe("setModifierAnswers", () => {
    test("saves a modifier's answer links idempotently", async () => {
      const [a1, a2] = await createAnswers(2);
      const m = await insertModifier({ name: "Tier" });
      await setModifierAnswers(m.id, [a1!, a2!]);
      expect((await getModifierAnswerIds(m.id)).sort((a, b) => a - b)).toEqual(
        [a1!, a2!].sort((a, b) => a - b),
      );

      // Re-saving replaces the whole set (the editor posts the full selection).
      await setModifierAnswers(m.id, [a2!]);
      expect(await getModifierAnswerIds(m.id)).toEqual([a2!]);
    });
  });

  describe("answerModifierQuantities", () => {
    test("sums a whole-order modifier's selections across listings", async () => {
      // A whole-order (scope=all) tier linked to two answers, each picked on a
      // different listing — the counts sum across both listings.
      const [a1, a2] = await createAnswers(2);
      const m = await insertModifier({ name: "Premium tier" });
      await patchModifier(m.id, { trigger: "answer" });
      await setModifierAnswers(m.id, [a1!, a2!]);

      const quantities = await answerModifierQuantities(
        { "1": [a1!], "2": [a2!] },
        new Map([
          [1, 2],
          [2, 3],
        ]),
      );
      expect(quantities).toEqual(new Map([[m.id, 5]]));
    });

    test("counts only selections on a scoped modifier's listings", async () => {
      // Scoped to listing 1, but the linked answer is also picked on listing 2
      // (out of scope). Only the listing-1 selection counts, so the modifier
      // isn't inflated to quantity 2.
      const [answerId] = await createAnswers(1);
      const m = await insertModifier({ name: "L1 tier" });
      await patchModifier(m.id, { scope: "listings", trigger: "answer" });
      await linkModifierListing(m.id, 1);
      await setModifierAnswers(m.id, [answerId!]);

      const quantities = await answerModifierQuantities(
        { "1": [answerId!], "2": [answerId!] },
        new Map([
          [1, 1],
          [2, 1],
        ]),
      );
      expect(quantities).toEqual(new Map([[m.id, 1]]));
    });

    test("ignores an unlinked answer picked alongside a linked one", async () => {
      const [linked, unlinked] = await createAnswers(2);
      const m = await insertModifier({ name: "Tier" });
      await patchModifier(m.id, { trigger: "answer" });
      await setModifierAnswers(m.id, [linked!]);
      // The other answer has no modifier link; picking it alongside the linked
      // answer must contribute nothing.
      const quantities = await answerModifierQuantities(
        { "1": [linked!, unlinked!] },
        new Map([[1, 2]]),
      );
      expect(quantities).toEqual(new Map([[m.id, 2]]));
    });

    test("ignores links to inactive or non-answer modifiers", async () => {
      // A link can outlive the modifier being deactivated or re-triggered; such
      // a link must never contribute a quantity.
      const [a1, a2] = await createAnswers(2);
      const inactive = await insertModifier({ name: "Inactive tier" });
      await patchModifier(inactive.id, { active: 0, trigger: "answer" });
      await setModifierAnswers(inactive.id, [a1!]);
      const automatic = await insertModifier({ name: "Automatic" });
      await setModifierAnswers(automatic.id, [a2!]);

      const quantities = await answerModifierQuantities(
        { "1": [a1!, a2!] },
        new Map([[1, 1]]),
      );
      expect(quantities).toEqual(new Map());
    });

    test("is empty when no answers were selected", async () => {
      expect(await answerModifierQuantities(undefined, new Map())).toEqual(
        new Map(),
      );
      expect(await answerModifierQuantities({}, new Map([[1, 2]]))).toEqual(
        new Map(),
      );
    });

    test("ignores answers with no linked modifier", async () => {
      const [answerId] = await createAnswers(1);
      expect(
        await answerModifierQuantities({ "1": [answerId!] }, new Map([[1, 4]])),
      ).toEqual(new Map());
    });
  });

  describe("oversubscribedAnswerTiers", () => {
    test("flags an answer tier requested beyond its stock", async () => {
      const m = await insertModifier({ name: "VIP tier", stock: 2 });
      await patchModifier(m.id, { trigger: "answer" });
      const items = [checkoutItem()];
      // Requested 3 > stock 2 → over-subscribed; 2 <= 2 → fine.
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities: new Map([[m.id, 3]]),
        }),
      ).toEqual(["VIP tier"]);
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities: new Map([[m.id, 2]]),
        }),
      ).toEqual([]);
    });

    test("accounts for stock already consumed", async () => {
      const m = await insertModifier({ name: "Limited", stock: 5 });
      await patchModifier(m.id, { trigger: "answer" });
      await insertModifierUsage(m.id, 1, 4, 0);
      const items = [checkoutItem()];
      // 1 remaining: requesting 2 over-subscribes, 1 is fine.
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities: new Map([[m.id, 2]]),
        }),
      ).toEqual(["Limited"]);
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities: new Map([[m.id, 1]]),
        }),
      ).toEqual([]);
    });

    test("ignores empty, unlimited, non-answer, and inactive", async () => {
      const items = [checkoutItem()];
      expect(await oversubscribedAnswerTiers(items, {})).toEqual([]);
      const unlimited = await insertModifier({ name: "Unlimited" });
      await patchModifier(unlimited.id, { trigger: "answer" });
      const automatic = await insertModifier({ name: "Auto", stock: 1 });
      const inactive = await insertModifier({ name: "Inactive", stock: 1 });
      await patchModifier(inactive.id, { active: 0, trigger: "answer" });
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities: new Map([
            [unlimited.id, 9],
            [automatic.id, 9],
            [inactive.id, 9],
          ]),
        }),
      ).toEqual([]);
    });

    test("ignores a tier the cart is too small for", async () => {
      // Stock 1, requested 3 — over-subscribed on stock alone — but the tier's
      // minimum subtotal isn't met, so resolveModifiers wouldn't apply it and
      // the booking must not be blocked.
      const m = await insertModifier({ name: "Big spenders", stock: 1 });
      await patchModifier(m.id, { min_subtotal: 999999, trigger: "answer" });
      expect(
        await oversubscribedAnswerTiers([checkoutItem({ unitPrice: 1000 })], {
          answerQuantities: new Map([[m.id, 3]]),
        }),
      ).toEqual([]);
    });

    test("respects the returning-buyer visit gate", async () => {
      const m = await insertModifier({ name: "Loyalty tier", stock: 1 });
      await patchModifier(m.id, { min_visits: 1, trigger: "answer" });
      const items = [checkoutItem()];
      const answerQuantities = new Map([[m.id, 3]]);
      // No visits → the gate blocks the tier, so it can't be over-subscribed.
      expect(
        await oversubscribedAnswerTiers(items, { answerQuantities }),
      ).toEqual([]);
      // Enough visits → the tier applies, and 3 > stock 1 over-subscribes it.
      expect(
        await oversubscribedAnswerTiers(items, {
          answerQuantities,
          ctx: { visits: 1 },
        }),
      ).toEqual(["Loyalty tier"]);
    });

    test("ignores a tier scoped to listings not in the cart", async () => {
      const m = await insertModifier({ name: "L9 tier", stock: 1 });
      await patchModifier(m.id, { scope: "listings", trigger: "answer" });
      await linkModifierListing(m.id, 9);
      // The cart is listing 1; the tier is scoped to listing 9, so it can't
      // apply and isn't reported sold out despite the over-subscription.
      expect(
        await oversubscribedAnswerTiers([checkoutItem({ listingId: 1 })], {
          answerQuantities: new Map([[m.id, 3]]),
        }),
      ).toEqual([]);
    });
  });
});
