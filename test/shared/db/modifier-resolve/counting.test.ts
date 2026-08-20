import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hashEmail } from "#db/contact-preferences.ts";
import {
  buyerVisits,
  getOptionalAddOns,
  oversubscribedAnswerTiers,
  resolveModifiers,
} from "#db/modifier-resolve.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { setContactVisits } from "#test-utils/contact-preferences.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertModifier,
  insertModifierUsage,
  patchModifier,
} from "#test-utils/modifiers.ts";

/**
 * The counting edges of the pricing engine: how many visits a buyer has, how
 * much stock a tier has left, and how little an add-on has to cost before the
 * order needs paying for. Each test sits on a boundary where one number
 * decides the answer.
 */

describeWithEnv("modifier-resolve counting edges", { db: true }, () => {
  describe("buyerVisits", () => {
    test("a buyer with no history has no visits, not one", async () => {
      expect(await buyerVisits("new@example.com")).toBe(0);
    });

    test("one usable detail is enough to read a count", async () => {
      // The phone is missing, so the email carries the whole answer.
      await setContactVisits(await hashEmail("solo@example.com"), 4);

      expect(await buyerVisits("solo@example.com")).toBe(4);
    });

    test("a detail of only spaces is nobody, so nothing is looked up", async () => {
      // Spaces are not a contact detail. A count stored against them belongs
      // to no buyer, and must not become this buyer's history.
      await setContactVisits(await hashEmail("   "), 3);

      expect(await buyerVisits("   ")).toBe(0);
    });
  });

  describe("oversubscribedAnswerTiers", () => {
    test("a tier with its stock exactly spent refuses one more", async () => {
      // Four of four are gone, so nothing is left and a request for one is
      // one too many.
      const tier = await insertModifier({ name: "Last one", stock: 4 });
      await patchModifier(tier.id, { trigger: "answer" });
      await insertModifierUsage(tier.id, 1, 4, 0);

      expect(
        await oversubscribedAnswerTiers([checkoutItem()], {
          answerQuantities: new Map([[tier.id, 1]]),
        }),
      ).toEqual(["Last one"]);
    });
  });

  describe("resolveModifiers", () => {
    test("an add-on asked for zero times does not price", async () => {
      // Zero means "not chosen". Only a request of one or more prices.
      const addOn = await insertModifier({ name: "Parking" });
      await patchModifier(addOn.id, { trigger: "optional" });

      const none = await resolveModifiers([checkoutItem()], {
        addOns: new Map([[addOn.id, 0]]),
      });
      expect(none.map((spec) => spec.name)).toEqual([]);

      const one = await resolveModifiers([checkoutItem()], {
        addOns: new Map([[addOn.id, 1]]),
      });
      expect(one.map((spec) => spec.name)).toEqual(["Parking"]);
    });
  });

  describe("getOptionalAddOns", () => {
    test("an add-on of one penny still sends the order to payment", async () => {
      // The smallest charge there is. A free order that picks it up stops
      // being free, so the checkout has to collect money.
      const penny = await insertModifier({
        calcKind: "fixed",
        calcValue: 0.01,
        direction: "charge",
        name: "Penny",
      });
      await patchModifier(penny.id, { trigger: "optional" });

      const [offered] = await getOptionalAddOns([1]);
      expect(offered).toMatchObject({
        name: "Penny",
        priceLabel: "+£0.01",
        requiresPayment: true,
      });
    });

    test("a discount add-on never sends the order to payment", async () => {
      const rebate = await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "discount",
        name: "Rebate",
      });
      await patchModifier(rebate.id, { trigger: "optional" });

      const [offered] = await getOptionalAddOns([1]);
      expect(offered).toMatchObject({ name: "Rebate", requiresPayment: false });
    });
  });
});
