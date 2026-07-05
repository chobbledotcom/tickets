import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import {
  hashEmail,
  hashPhone,
  recordVisit,
} from "#shared/db/contact-preferences.ts";
import {
  ADDON_MAX_QUANTITY,
  type AddOnReachabilityCheck,
  answerModifierQuantities,
  buyerVisits,
  childUnreachableAddOnError,
  getOptionalAddOns,
  hasPromoCodeModifiers,
  oversubscribedAnswerTiers,
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import {
  getModifierAnswerIds,
  setModifierAnswers,
} from "#shared/db/modifiers.ts";
import { answersTable, questionsTable } from "#shared/db/questions.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import {
  checkoutItem,
  consumeModifierStock,
  createTestListing,
  describeWithEnv,
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
} from "#test-utils";

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

describe("childUnreachableAddOnError", () => {
  // scope [10] names the child (10) and reaches no parent page (20): a dead end.
  const childOnly: AddOnReachabilityCheck = {
    active: true,
    name: "Child-only add-on",
    scope: [10],
    trigger: "optional",
  };
  const childIds = new Set([10]);
  const parentPage = new Set([20]);

  test("flags an active opt-in add-on reachable only through the child", () => {
    expect(
      childUnreachableAddOnError(childOnly, childIds, parentPage),
    ).not.toBeNull();
  });

  test("a global (null-scope) add-on is never a child dead end", () => {
    // A whole-order scope applies everywhere, so it always keeps a reachable
    // page and adding a child can't orphan it.
    expect(
      childUnreachableAddOnError(
        { ...childOnly, scope: null },
        childIds,
        parentPage,
      ),
    ).toBeNull();
  });

  test("only active, opt-in add-ons are gated", () => {
    // An inactive add-on never loads on a page, and a non-opt-in (automatic)
    // add-on isn't a buyer-chosen extra: neither can be orphaned by a new child,
    // even with a scope that would otherwise dead-end.
    expect(
      childUnreachableAddOnError(
        { ...childOnly, active: false },
        childIds,
        parentPage,
      ),
    ).toBeNull();
    expect(
      childUnreachableAddOnError(
        { ...childOnly, trigger: "automatic" },
        childIds,
        parentPage,
      ),
    ).toBeNull();
  });
});

describeWithEnv("db > modifier-resolve", { db: true }, () => {
  describe("resolveModifiers", () => {
    test("builds a spec for an active automatic whole-order modifier", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const specs = await resolveModifiers([checkoutItem()]);
      expect(specs).toEqual([
        {
          id: specs[0]!.id,
          kind: "fixed",
          listingIds: null,
          name: "Parking",
          quantity: 1,
          trigger: "automatic",
          value: toMinorUnits(5),
        },
      ]);
    });

    test("negates the value for a discount and leaves a multiplier as-is", async () => {
      await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "Loyalty",
      });
      await insertModifier({
        calcKind: "multiply",
        calcValue: 1.5,
        direction: "charge",
        name: "Peak",
      });
      const specs = await resolveModifiers([checkoutItem()]);
      const byName = new Map(specs.map((s) => [s.name, s]));
      expect(byName.get("Loyalty")!.value).toBe(-10);
      expect(byName.get("Peak")!.value).toBe(1.5);
    });

    test("excludes inactive, non-automatic, scoped, or below-minimum modifiers", async () => {
      const inactive = await insertModifier({ name: "Inactive" });
      await patchModifier(inactive.id, { active: 0 });
      const coded = await insertModifier({ name: "Coded" });
      await patchModifier(coded.id, { trigger: "code" });
      const scoped = await insertModifier({ name: "Scoped" });
      await patchModifier(scoped.id, { scope: "listings" });
      const gated = await insertModifier({ name: "BigSpendOnly" });
      await patchModifier(gated.id, { min_subtotal: 999999 });

      const specs = await resolveModifiers([checkoutItem({ unitPrice: 1000 })]);
      expect(specs.map((s) => s.name)).toEqual([]);
    });

    test("includes a stock-limited modifier while stock remains", async () => {
      await insertModifier({ name: "Plenty", stock: 5 });
      const specs = await resolveModifiers([checkoutItem()]);
      expect(specs.map((s) => s.name)).toContain("Plenty");
    });

    test("excludes a modifier whose stock is used up", async () => {
      const m = await insertModifier({ name: "Limited", stock: 1 });
      await consumeModifierStock(1, [
        { amountApplied: 500, modifierId: m.id, quantity: 1 },
      ]);
      const specs = await resolveModifiers([checkoutItem()]);
      expect(specs.map((s) => s.name)).not.toContain("Limited");
    });

    test("applies a listing-scoped modifier only alongside a linked listing", async () => {
      const m = await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "VIP",
      });
      await patchModifier(m.id, { scope: "listings" });
      await linkModifierListing(m.id, 1);

      const applied = await resolveModifiers([checkoutItem({ listingId: 1 })]);
      expect(applied.find((s) => s.name === "VIP")?.listingIds).toEqual([1]);

      const skipped = await resolveModifiers([checkoutItem({ listingId: 2 })]);
      expect(skipped.map((s) => s.name)).not.toContain("VIP");
    });

    test("applies a code modifier only when the matching code is entered", async () => {
      const m = await insertModifier({ name: "SUMMER" });
      await patchModifier(m.id, {
        code_index: await hmacHash(normalizeCode("Summer25")),
        trigger: "code",
      });

      const withoutCode = await resolveModifiers([checkoutItem()]);
      expect(withoutCode.map((s) => s.name)).not.toContain("SUMMER");

      const wrongCode = await resolveModifiers([checkoutItem()], {
        code: "winter",
      });
      expect(wrongCode.map((s) => s.name)).not.toContain("SUMMER");

      // Matching is case-insensitive (normalised before hashing).
      const rightCode = await resolveModifiers([checkoutItem()], {
        code: "SUMMER25",
      });
      expect(rightCode.map((s) => s.name)).toContain("SUMMER");
    });

    test("applies an opt-in add-on at the chosen quantity only when selected", async () => {
      const m = await insertModifier({ name: "T-shirt" });
      await patchModifier(m.id, { trigger: "optional" });

      const unselected = await resolveModifiers([checkoutItem()]);
      expect(unselected.map((s) => s.name)).not.toContain("T-shirt");

      const selected = await resolveModifiers([checkoutItem()], {
        addOns: new Map([[m.id, 3]]),
      });
      expect(selected.find((s) => s.name === "T-shirt")?.quantity).toBe(3);
    });

    test("applies a visit-gated automatic modifier only for returning buyers", async () => {
      await insertModifier({
        direction: "discount",
        minVisits: 1,
        name: "Welcome back",
      });

      expect(
        (await resolveModifiers([checkoutItem()])).map((s) => s.name),
      ).toEqual([]);

      const returning = await resolveModifiers([checkoutItem()], {
        ctx: { visits: 1 },
      });
      expect(returning.map((s) => s.name)).toEqual(["Welcome back"]);
    });

    test("caps an opt-in add-on quantity at the remaining stock", async () => {
      const m = await insertModifier({ name: "Limited tee", stock: 2 });
      await patchModifier(m.id, { trigger: "optional" });

      const specs = await resolveModifiers([checkoutItem()], {
        addOns: new Map([[m.id, 5]]),
      });
      expect(specs.find((s) => s.name === "Limited tee")?.quantity).toBe(2);
    });

    test("applies an answer-triggered modifier when a linked answer is selected", async () => {
      const [answerId] = await createAnswers(1);
      const m = await insertModifier({ name: "Large size" });
      await patchModifier(m.id, { trigger: "answer" });
      await setModifierAnswers(m.id, [answerId!]);

      // Not selected: the modifier doesn't trigger.
      const unselected = await resolveModifiers([checkoutItem()]);
      expect(unselected.map((s) => s.name)).not.toContain("Large size");

      // The linked answer selected on listing 1, which has 2 tickets: applies x2.
      const selected = await resolveModifiers([checkoutItem()], {
        answerQuantities: await answerModifierQuantities(
          { "1": [answerId!] },
          new Map([[1, 2]]),
        ),
      });
      const spec = selected.find((s) => s.name === "Large size");
      expect(spec?.trigger).toBe("answer");
      expect(spec?.quantity).toBe(2);
    });

    test("caps an answer-triggered modifier quantity at remaining stock", async () => {
      const [answerId] = await createAnswers(1);
      const m = await insertModifier({ name: "Limited tier", stock: 2 });
      await patchModifier(m.id, { trigger: "answer" });
      await setModifierAnswers(m.id, [answerId!]);

      const specs = await resolveModifiers([checkoutItem()], {
        answerQuantities: await answerModifierQuantities(
          { "1": [answerId!] },
          new Map([[1, 5]]),
        ),
      });
      expect(specs.find((s) => s.name === "Limited tier")?.quantity).toBe(2);
    });

    test("applies a group-scoped modifier to the linked group's listings", async () => {
      const listing = await createTestListing({
        groupId: 42,
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const m = await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "GroupWide",
      });
      await patchModifier(m.id, { scope: "groups" });
      await linkModifierGroup(m.id, 42);

      const applied = await resolveModifiers([
        checkoutItem({ listingId: listing.id }),
      ]);
      expect(applied.find((s) => s.name === "GroupWide")?.listingIds).toEqual([
        listing.id,
      ]);
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
      await consumeModifierStock(1, [
        { amountApplied: 0, modifierId: m.id, quantity: 4 },
      ]);
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

  describe("buyerVisits", () => {
    test("returns 0 when no contact identifier is present", async () => {
      expect(await buyerVisits("", "")).toBe(0);
    });

    test("reads the max visit count across email and phone", async () => {
      await recordVisit(await hashEmail("seen@example.com"));
      await recordVisit(await hashPhone("07700 900123"));
      await recordVisit(await hashPhone("07700 900123"));

      expect(await buyerVisits("seen@example.com", "07700 900123")).toBe(2);
    });
  });

  describe("hasPromoCodeModifiers", () => {
    test("is false with no code modifiers and true once one exists", async () => {
      await insertModifier({ name: "Automatic" });
      expect(await hasPromoCodeModifiers()).toBe(false);

      const coded = await insertModifier({ name: "Coded" });
      await patchModifier(coded.id, { trigger: "code" });
      expect(await hasPromoCodeModifiers()).toBe(true);
    });
  });

  describe("getOptionalAddOns", () => {
    test("offers a whole-order add-on with its price label and quantity cap", async () => {
      const m = await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      await patchModifier(m.id, { trigger: "optional" });

      const addOns = await getOptionalAddOns([1]);
      expect(addOns).toEqual([
        {
          id: m.id,
          maxQuantity: ADDON_MAX_QUANTITY,
          name: "Parking",
          priceLabel: "+£5",
          requiresPayment: true,
        },
      ]);
    });

    test("labels a percentage discount add-on with a minus sign", async () => {
      const m = await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "Member rebate",
      });
      await patchModifier(m.id, { trigger: "optional" });
      const addOns = await getOptionalAddOns([1]);
      expect(addOns[0]?.priceLabel).toBe("−10%");
      expect(addOns[0]?.requiresPayment).toBe(false);
    });

    test("labels a multiplier add-on with its bare factor", async () => {
      const m = await insertModifier({
        calcKind: "multiply",
        calcValue: 1.5,
        direction: "charge",
        name: "Peak surcharge",
      });
      await patchModifier(m.id, { trigger: "optional" });
      const addOns = await getOptionalAddOns([1]);
      expect(addOns[0]?.priceLabel).toBe("×1.5");
      expect(addOns[0]?.requiresPayment).toBe(false);
    });

    test("caps maxQuantity at the remaining stock", async () => {
      const m = await insertModifier({ name: "Tee", stock: 3 });
      await patchModifier(m.id, { trigger: "optional" });
      const addOns = await getOptionalAddOns([1]);
      expect(addOns[0]?.maxQuantity).toBe(3);
    });

    test("omits a sold-out add-on", async () => {
      const m = await insertModifier({ name: "Sold out", stock: 1 });
      await patchModifier(m.id, { trigger: "optional" });
      await consumeModifierStock(1, [
        { amountApplied: 500, modifierId: m.id, quantity: 1 },
      ]);
      expect(await getOptionalAddOns([1])).toEqual([]);
    });

    test("offers a listing-scoped add-on only on a page with its listing", async () => {
      const m = await insertModifier({ name: "Scoped tee" });
      await patchModifier(m.id, { scope: "listings", trigger: "optional" });
      await linkModifierListing(m.id, 7);

      expect(await getOptionalAddOns([7])).toHaveLength(1);
      expect(await getOptionalAddOns([8])).toEqual([]);
    });

    test("excludes automatic and code modifiers", async () => {
      await insertModifier({ name: "Automatic" });
      const coded = await insertModifier({ name: "Coded" });
      await patchModifier(coded.id, { trigger: "code" });
      expect(await getOptionalAddOns([1])).toEqual([]);
    });
  });

  describe("specsFromRefs", () => {
    test("returns [] for no references", async () => {
      expect(await specsFromRefs([])).toEqual([]);
    });

    test("rebuilds specs from references, re-fetching current values", async () => {
      const created = await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const specs = await specsFromRefs([{ i: created.id, q: 2 }]);
      expect(specs).toEqual([
        {
          id: created.id,
          kind: "fixed",
          listingIds: null,
          name: "Parking",
          quantity: 2,
          trigger: "automatic",
          value: toMinorUnits(5),
        },
      ]);
    });

    test("rebuilds the listing ids for a scoped reference", async () => {
      const m = await insertModifier({ name: "Scoped" });
      await patchModifier(m.id, { scope: "listings" });
      await linkModifierListing(m.id, 3);
      const specs = await specsFromRefs([{ i: m.id, q: 1 }]);
      expect(specs[0]?.listingIds).toEqual([3]);
    });

    test("drops references to modifiers that no longer resolve", async () => {
      const created = await insertModifier({ name: "Gone" });
      await patchModifier(created.id, { active: 0 });
      expect(await specsFromRefs([{ i: created.id, q: 1 }])).toEqual([]);
      expect(await specsFromRefs([{ i: 9999, q: 1 }])).toEqual([]);
    });

    test("re-checks the visit gate when rebuilding references", async () => {
      const created = await insertModifier({
        direction: "discount",
        minVisits: 1,
        name: "Returning",
      });

      expect(await specsFromRefs([{ i: created.id, q: 1 }])).toEqual([]);
      expect(
        (await specsFromRefs([{ i: created.id, q: 1 }], { visits: 1 })).map(
          (s) => s.name,
        ),
      ).toEqual(["Returning"]);
    });
  });
});
