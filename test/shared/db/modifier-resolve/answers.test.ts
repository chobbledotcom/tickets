import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answerModifierQuantities,
  oversubscribedAnswerTiers,
  resolveModifiers,
} from "#db/modifier-resolve.ts";
import type { ModifierInput } from "#db/modifiers.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertModifierUsage, patchModifier } from "#test-utils/modifiers.ts";
import { resolveAnswerPicks, setUpAnswerModifier } from "./answer-setup.ts";

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

/** Register one corrupt-cap scenario as its own test: a repaired or imported
 * row carries a cap no admin form could save, and resolving an order that
 * picked the answer must refuse it loudly rather than silently drop the
 * charge from the order. */
const refusesStoredCap = (
  description: string,
  badCap: number,
  ticketsPicked = 5,
): void =>
  test(description, async () => {
    const { answerIds, modifierId } = await setUpAnswerModifier(1, {
      maxPerOrder: 1,
      name: "Zone 2 delivery",
    });
    await patchModifier(modifierId, { max_per_order: badCap });
    await assertRejects(
      () =>
        resolveAnswerPicks(
          { "1": [answerIds[0]!] },
          new Map([[1, ticketsPicked]]),
        ),
      Error,
      "max_per_order",
    );
  });

/**
 * How a linked answer turns into a quantity, and how the per-order cap and
 * the eligibility gates clamp that quantity before stock does.
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

    test("does not read the cap of an answer modifier no order picked", async () => {
      // The same corrupt row, but this cart picked no linked answer: the cap
      // decides nothing here, so the order prices normally without it.
      const { modifierId } = await setUpAnswerModifier(1, {
        maxPerOrder: 1,
        name: "Zone 2 delivery",
      });
      await patchModifier(modifierId, { max_per_order: 0 });

      const specs = await resolveModifiers([checkoutItem()]);
      expect(specs.map((s) => s.name)).not.toContain("Zone 2 delivery");
    });

    test("does not read the cap of a modifier the cart is too small for", async () => {
      // Same corrupt row behind a minimum subtotal this cart does not meet:
      // the gates run first, so the modifier never applies and its cap is
      // never read.
      const { answerIds, modifierId } = await setUpAnswerModifier(1, {
        maxPerOrder: 1,
        name: "Big spenders only",
      });
      await patchModifier(modifierId, {
        max_per_order: 0,
        min_subtotal: 999999,
      });

      const specs = await resolveAnswerPicks(
        { "1": [answerIds[0]!] },
        new Map([[1, 2]]),
      );
      expect(specs.map((s) => s.name)).not.toContain("Big spenders only");
    });

    refusesStoredCap("refuses a stored per-order cap of zero", 0);

    refusesStoredCap("refuses a fractional stored per-order cap", 2.5);

    refusesStoredCap(
      "refuses a corrupt cap when one ticket picked the answer",
      0,
      1,
    );
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
});
