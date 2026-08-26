import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answerModifierQuantities,
  oversubscribedAnswerTiers,
  resolveModifiers,
} from "#db/modifier-resolve.ts";
import {
  getModifierAnswerIds,
  type ModifierInput,
  setModifierAnswers,
} from "#db/modifiers.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertModifier,
  insertModifierUsage,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";

/** Create a question with `count` answers, returning their real ids (answer
 * ids are real rows now that the link is a modifier_id column on answers). */
const createAnswers = async (count: number): Promise<number[]> => {
  const q = await questionsTable.insert({ displayType: "radio", text: "Q?" });
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      sortOrder: i,
      text: `A${i + 1}`,
    });
    ids.push(a.id);
  }
  return ids;
};

/** Create an answer-triggered modifier linked to `count` fresh answers. */
const setUpAnswerModifier = async (
  count: number,
  input: Partial<ModifierInput> = {},
): Promise<{ answerIds: number[]; modifierId: number }> => {
  const answerIds = await createAnswers(count);
  const m = await insertModifier(input);
  await patchModifier(m.id, { trigger: "answer" });
  await setModifierAnswers(m.id, answerIds);
  return { answerIds, modifierId: m.id };
};

/** Resolve a one-item cart where each listed listing picked answers. */
const resolveAnswerPicks = async (
  picks: Record<string, number[]>,
  quantities: Map<number, number>,
): Promise<ModifierSpec[]> =>
  resolveModifiers([checkoutItem()], {
    answerQuantities: await answerModifierQuantities(picks, quantities),
  });

/** Register one cap scenario as its own test: five tickets picked the answer,
 * and one limit decides how many times the modifier applies. */
const capsQuantityAt = (
  description: string,
  input: Partial<ModifierInput> & { name: string },
  expected: number,
): void =>
  test(description, async () => {
    const { answerIds } = await setUpAnswerModifier(1, input);
    const specs = await resolveAnswerPicks(
      { "1": [answerIds[0]!] },
      new Map([[1, 5]]),
    );
    expect(specs.find((s) => s.name === input.name)?.quantity).toBe(expected);
  });

/**
 * The question-answer trigger end to end: how a linked answer turns into a
 * quantity, how the per-order cap and stock clamp that quantity, and how the
 * answer links themselves are stored and read.
 */
describeWithEnv("modifier-resolve answer triggers", { db: true }, () => {
  describe("resolveModifiers", () => {
    test("applies an answer-triggered modifier when a linked answer is selected", async () => {
      const { answerIds } = await setUpAnswerModifier(1, {
        name: "Large size",
      });

      // Not selected: the modifier doesn't trigger.
      const unselected = await resolveModifiers([checkoutItem()]);
      expect(unselected.map((s) => s.name)).not.toContain("Large size");

      // The linked answer selected on listing 1, which has 2 tickets: applies x2.
      const selected = await resolveAnswerPicks(
        { "1": [answerIds[0]!] },
        new Map([[1, 2]]),
      );
      const spec = selected.find((s) => s.name === "Large size");
      expect(spec?.trigger).toBe("answer");
      expect(spec?.quantity).toBe(2);
    });

    capsQuantityAt(
      "caps an answer modifier at its remaining stock",
      { name: "Limited tier", stock: 2 },
      2,
    );

    capsQuantityAt(
      "caps a per-order-capped answer modifier at its max",
      { maxPerOrder: 2, name: "Two per order" },
      2,
    );

    capsQuantityAt(
      "applies a once-per-order answer modifier once however many tickets picked it",
      { maxPerOrder: 1, name: "Zone 2 delivery" },
      1,
    );

    test("applies a once-per-order answer modifier once across several linked answers", async () => {
      const { answerIds } = await setUpAnswerModifier(2, {
        maxPerOrder: 1,
        name: "Delivery",
      });

      // Both answers picked (one per listing), each listing holding 2 tickets:
      // the requested quantity is 4, the once-per-order cap still applies x1.
      const specs = await resolveAnswerPicks(
        { "1": [answerIds[0]!], "2": [answerIds[1]!] },
        new Map([
          [1, 2],
          [2, 2],
        ]),
      );
      expect(specs.find((s) => s.name === "Delivery")?.quantity).toBe(1);
    });
  });

  describe("oversubscribedAnswerTiers with a per-order cap", () => {
    test("counts stock per order for a once-per-order answer modifier", async () => {
      const { answerIds, modifierId } = await setUpAnswerModifier(1, {
        maxPerOrder: 1,
        name: "Van slot",
        stock: 2,
      });
      // One order already used a slot, so one of the two remains. Three
      // tickets picked the answer, but a once-per-order modifier needs only
      // one slot for this order — per-ticket counting would report it sold out.
      await insertModifierUsage(modifierId, 1, 1, 0);

      const picks = { "1": [answerIds[0]!] };
      const quantities = await answerModifierQuantities(
        picks,
        new Map([[1, 3]]),
      );
      expect(
        await oversubscribedAnswerTiers([checkoutItem()], {
          answerQuantities: quantities,
        }),
      ).toEqual([]);

      const specs = await resolveAnswerPicks(picks, new Map([[1, 3]]));
      expect(specs.find((s) => s.name === "Van slot")?.quantity).toBe(1);
    });

    test("reports a once-per-order answer modifier whose stock ran out", async () => {
      const { answerIds, modifierId } = await setUpAnswerModifier(1, {
        maxPerOrder: 1,
        name: "Last van",
        stock: 1,
      });
      // The only slot is gone, and this order needs it.
      await insertModifierUsage(modifierId, 1, 1, 0);

      const quantities = await answerModifierQuantities(
        { "1": [answerIds[0]!] },
        new Map([[1, 3]]),
      );
      expect(
        await oversubscribedAnswerTiers([checkoutItem()], {
          answerQuantities: quantities,
        }),
      ).toEqual(["Last van"]);
    });
  });

  describe("answer modifier links", () => {
    test("setModifierAnswers saves a modifier's answer links idempotently", async () => {
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

    test("answerModifierQuantities sums a whole-order modifier's selections across listings", async () => {
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

    test("answerModifierQuantities counts only selections on a scoped modifier's listings", async () => {
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

    test("oversubscribedAnswerTiers flags an answer tier requested beyond its stock", async () => {
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

    test("oversubscribedAnswerTiers accounts for stock already consumed", async () => {
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

    test("oversubscribedAnswerTiers ignores empty, unlimited, non-answer, and inactive", async () => {
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

    test("oversubscribedAnswerTiers ignores a tier the cart is too small for", async () => {
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

    test("oversubscribedAnswerTiers respects the returning-buyer visit gate", async () => {
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

    test("oversubscribedAnswerTiers ignores a tier scoped to listings not in the cart", async () => {
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

    test("answerModifierQuantities ignores an unlinked answer picked alongside a linked one", async () => {
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

    test("answerModifierQuantities ignores links to inactive or non-answer modifiers", async () => {
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

    test("answerModifierQuantities is empty when no answers were selected", async () => {
      expect(await answerModifierQuantities(undefined, new Map())).toEqual(
        new Map(),
      );
      expect(await answerModifierQuantities({}, new Map([[1, 2]]))).toEqual(
        new Map(),
      );
    });

    test("answerModifierQuantities ignores answers with no linked modifier", async () => {
      const [answerId] = await createAnswers(1);
      expect(
        await answerModifierQuantities({ "1": [answerId!] }, new Map([[1, 4]])),
      ).toEqual(new Map());
    });
  });
});
