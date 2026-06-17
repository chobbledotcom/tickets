import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toMinorUnits } from "#shared/currency.ts";
import { getDb } from "#shared/db/client.ts";
import {
  hashEmail,
  hashPhone,
  recordVisit,
} from "#shared/db/contact-preferences.ts";
import {
  buyerVisits,
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import { consumeModifierStock } from "#shared/db/modifier-usage.ts";
import { type ModifierInput, modifiersTable } from "#shared/db/modifiers.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

const linkListing = (modifierId: number, listingId: number) =>
  getDb().execute({
    args: [modifierId, listingId],
    sql: "INSERT INTO modifier_listings (modifier_id, listing_id) VALUES (?, ?)",
  });

const linkGroup = (modifierId: number, groupId: number) =>
  getDb().execute({
    args: [modifierId, groupId],
    sql: "INSERT INTO modifier_groups (modifier_id, group_id) VALUES (?, ?)",
  });

const item = (overrides: Partial<CheckoutItem> = {}): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

const insertModifier = (overrides: Partial<ModifierInput> = {}) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
    ...overrides,
  });

/** Override behavioural columns the base create form doesn't expose yet. */
const patchModifier = (id: number, set: Record<string, string | number>) => {
  const cols = Object.keys(set);
  const assignments = cols.map((c) => `${c} = ?`).join(", ");
  return getDb().execute({
    args: [...cols.map((c) => set[c]!), id],
    sql: `UPDATE modifiers SET ${assignments} WHERE id = ?`,
  });
};

describeWithEnv("db > modifier-resolve", { db: true }, () => {
  describe("resolveModifiers", () => {
    test("builds a spec for an active automatic whole-order modifier", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const specs = await resolveModifiers([item()]);
      expect(specs).toEqual([
        {
          id: specs[0]!.id,
          kind: "fixed",
          listingIds: null,
          name: "Parking",
          quantity: 1,
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
      const specs = await resolveModifiers([item()]);
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

      const specs = await resolveModifiers([item({ unitPrice: 1000 })]);
      expect(specs.map((s) => s.name)).toEqual([]);
    });

    test("includes a stock-limited modifier while stock remains", async () => {
      await insertModifier({ name: "Plenty", stock: 5 });
      const specs = await resolveModifiers([item()]);
      expect(specs.map((s) => s.name)).toContain("Plenty");
    });

    test("excludes a modifier whose stock is used up", async () => {
      const m = await insertModifier({ name: "Limited", stock: 1 });
      await consumeModifierStock(1, [
        { amountApplied: 500, modifierId: m.id, quantity: 1 },
      ]);
      const specs = await resolveModifiers([item()]);
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
      await linkListing(m.id, 1);

      const applied = await resolveModifiers([item({ listingId: 1 })]);
      expect(applied.find((s) => s.name === "VIP")?.listingIds).toEqual([1]);

      const skipped = await resolveModifiers([item({ listingId: 2 })]);
      expect(skipped.map((s) => s.name)).not.toContain("VIP");
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
      await linkGroup(m.id, 42);

      const applied = await resolveModifiers([item({ listingId: listing.id })]);
      expect(applied.find((s) => s.name === "GroupWide")?.listingIds).toEqual([
        listing.id,
      ]);
    });

    test("excludes a min_visits modifier for a buyer below the threshold", async () => {
      const m = await insertModifier({ name: "WelcomeBack" });
      await patchModifier(m.id, { min_visits: 1 });

      // Default context = 0 visits (a first-time buyer): the gate excludes it.
      const firstTime = await resolveModifiers([item()]);
      expect(firstTime.map((s) => s.name)).not.toContain("WelcomeBack");

      // A returning buyer (>= the threshold) gets it.
      const returning = await resolveModifiers([item()], { visits: 1 });
      expect(returning.map((s) => s.name)).toContain("WelcomeBack");
    });

    test("applies a min_visits modifier once the buyer meets the threshold exactly", async () => {
      const m = await insertModifier({ name: "Loyalty5" });
      await patchModifier(m.id, { min_visits: 5 });

      expect(
        (await resolveModifiers([item()], { visits: 4 })).map((s) => s.name),
      ).not.toContain("Loyalty5");
      expect(
        (await resolveModifiers([item()], { visits: 5 })).map((s) => s.name),
      ).toContain("Loyalty5");
    });
  });

  describe("buyerVisits", () => {
    test("returns 0 for an unknown buyer and when no identifiers are given", async () => {
      expect(await buyerVisits("unknown@example.com")).toBe(0);
      expect(await buyerVisits()).toBe(0);
      expect(await buyerVisits("", "")).toBe(0);
    });

    test("reads the visit count for a known email", async () => {
      await recordVisit(await hashEmail("seen@example.com"));
      await recordVisit(await hashEmail("seen@example.com"));
      expect(await buyerVisits("seen@example.com")).toBe(2);
    });

    test("takes the max across the email and phone identifiers", async () => {
      await recordVisit(await hashEmail("max@example.com"));
      await recordVisit(await hashPhone("07700 900333"));
      await recordVisit(await hashPhone("07700 900333"));
      await recordVisit(await hashPhone("07700 900333"));
      // email=1, phone=3 → max is 3.
      expect(await buyerVisits("max@example.com", "07700 900333")).toBe(3);
    });

    test("treats a non-string identifier (malformed metadata) as absent", async () => {
      // Provider metadata is adversarial; a non-string email/phone must be
      // ignored rather than throwing on .trim().
      expect(
        await buyerVisits(
          12345 as unknown as string,
          true as unknown as string,
        ),
      ).toBe(0);
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
          value: toMinorUnits(5),
        },
      ]);
    });

    test("rebuilds the listing ids for a scoped reference", async () => {
      const m = await insertModifier({ name: "Scoped" });
      await patchModifier(m.id, { scope: "listings" });
      await linkListing(m.id, 3);
      const specs = await specsFromRefs([{ i: m.id, q: 1 }]);
      expect(specs[0]?.listingIds).toEqual([3]);
    });

    test("drops references to modifiers that no longer resolve", async () => {
      const created = await insertModifier({ name: "Gone" });
      await patchModifier(created.id, { active: 0 });
      expect(await specsFromRefs([{ i: created.id, q: 1 }])).toEqual([]);
      expect(await specsFromRefs([{ i: 9999, q: 1 }])).toEqual([]);
    });

    test("drops a min_visits reference for a buyer below the threshold (anti-spoof)", async () => {
      // A crafted checkout could reference a returning-customer modifier the
      // buyer isn't entitled to; the webhook re-check drops it so the re-derived
      // total no longer matches and the refund path fires.
      const m = await insertModifier({ name: "ReturningOnly" });
      await patchModifier(m.id, { min_visits: 1 });

      // Default context = 0 visits: the ref is dropped.
      expect(await specsFromRefs([{ i: m.id, q: 1 }])).toEqual([]);

      // A genuinely returning buyer keeps it.
      const kept = await specsFromRefs([{ i: m.id, q: 1 }], { visits: 1 });
      expect(kept.map((s) => s.name)).toEqual(["ReturningOnly"]);
    });
  });
});
