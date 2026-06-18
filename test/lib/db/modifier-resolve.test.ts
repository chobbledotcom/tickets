import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { getDb } from "#shared/db/client.ts";
import {
  hashEmail,
  hashPhone,
  recordVisit,
} from "#shared/db/contact-preferences.ts";
import {
  ADDON_MAX_QUANTITY,
  buyerVisits,
  getOptionalAddOns,
  hasPromoCodeModifiers,
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import { consumeModifierStock } from "#shared/db/modifier-usage.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import {
  checkoutItem,
  createTestListing,
  describeWithEnv,
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
} from "#test-utils";

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

    test("applies a group-scoped modifier to the linked group's listings", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await getDb().execute({
        args: [42, listing.id],
        sql: "UPDATE listings SET group_id = ? WHERE id = ?",
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
