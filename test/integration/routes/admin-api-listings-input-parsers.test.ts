import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bodyToCreateInput, bodyToUpdateInput } from "#routes/admin/api.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("bodyToCreateInput", () => {
    test("returns error for non-string name", async () => {
      const result = await bodyToCreateInput({ max_attendees: 10, name: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("name is required");
    });

    test("returns error for a whitespace-only name", async () => {
      const result = await bodyToCreateInput({ max_attendees: 10, name: "  " });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("name is required");
    });

    test("returns error for missing max_attendees", async () => {
      const result = await bodyToCreateInput({ name: "Test" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("max_attendees is required and must be >= 1");
      }
    });

    test("returns error when max_attendees is zero", async () => {
      const result = await bodyToCreateInput({
        max_attendees: 0,
        name: "Test",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("max_attendees is required and must be >= 1");
      }
    });

    test("handles all field types correctly", async () => {
      const result = await bodyToCreateInput({
        active: false,
        bookable_alone: true,
        bookable_days: ["Monday"],
        closes_at: "2026-06-14T23:59:00Z",
        date: "2026-06-15T10:00:00Z",
        day_prices: { 0: 900, 1: 1200 },
        duration_days: 3,
        max_attendees: 10,
        max_price: 5000,
        name: "Test",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.active).toBe(false);
        expect(result.value.bookableAlone).toBe(true);
        expect(result.value.bookableDays).toEqual(["Monday"]);
        expect(result.value.date).toBe("2026-06-15T10:00:00Z");
        expect(result.value.dayPrices).toEqual({ 1: 1200 });
        expect(result.value.durationDays).toBe(3);
        expect(result.value.maxPrice).toBe(5000);
        expect(result.value.slug).toBeTruthy();
      }
    });

    test("defaults max_price to zero", async () => {
      const result = await bodyToCreateInput({
        max_attendees: 10,
        name: "No Maximum Price",
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.maxPrice).toBe(0);
    });

    test("rejects a non-array group_ids", async () => {
      const result = await bodyToCreateInput({
        group_ids: "5",
        max_attendees: 10,
        name: "Bad Groups",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("group_ids must be an array");
    });

    test("rejects group_ids with non-positive-integer entries", async () => {
      const result = await bodyToCreateInput({
        group_ids: ["5"],
        max_attendees: 10,
        name: "Bad Entry",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("positive integer ids");
      }
    });

    test("maps the use_defaults flag both ways and omits it when absent", async () => {
      // true/false both round-trip (so the API can opt in *and* out), and an
      // absent flag stays absent rather than defaulting to either value.
      const cases: [boolean | undefined, boolean | undefined][] = [
        [true, true],
        [false, false],
        [undefined, undefined],
      ];
      for (const [sent, expected] of cases) {
        const body: Record<string, unknown> = {
          max_attendees: 10,
          name: "Inheriting",
        };
        if (sent !== undefined) body.use_defaults = sent;
        const result = await bodyToCreateInput(body);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.useDefaults).toBe(expected);
      }
    });
  });

  describe("bodyToUpdateInput", () => {
    test("rejects malformed group_ids instead of silently clearing membership", async () => {
      const existing = testListingWithCount({
        max_attendees: 10,
        name: "Has Groups",
        slug: "has-groups",
      });
      const result = await bodyToUpdateInput({ group_ids: ["5"] }, existing);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("positive integer ids");
      }
    });

    test("preserves existing values when fields not provided", async () => {
      const existing = testListingWithCount({
        bookable_days: ["Monday"],
        closes_at: "2026-01-02T00:00:00.000Z",
        date: "2026-01-01T00:00:00.000Z",
        description: "Existing desc",
        location: "Old Place",
        max_attendees: 50,
        max_quantity: 2,
        maximum_days_after: 90,
        minimum_days_before: 1,
        name: "Existing",
        slug: "existing-slug",
        thank_you_url: "https://old.com/thanks",
        unit_price: 100,
        webhook_url: "https://old.com/hook",
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("Existing");
        expect(result.value.description).toBe("Existing desc");
        expect(result.value.location).toBe("Old Place");
        expect(result.value.unitPrice).toBe(100);
        expect(result.value.maxQuantity).toBe(2);
        expect(result.value.thankYouUrl).toBe("https://old.com/thanks");
        expect(result.value.webhookUrl).toBe("https://old.com/hook");
        expect(result.value.active).toBe(true);
        expect(result.value.fields).toBe("email");
        expect(result.value.closesAt).toBe("2026-01-02T00:00:00.000Z");
        expect(result.value.listingType).toBe("standard");
        expect(result.value.bookableDays).toEqual(["Monday"]);
        expect(result.value.minimumDaysBefore).toBe(1);
        expect(result.value.maximumDaysAfter).toBe(90);
        expect(result.value.nonTransferable).toBe(false);
        expect(result.value.canPayMore).toBe(false);
        expect(result.value.hidden).toBe(false);
        expect(result.value.maxPrice).toBe(0);
      }
    });

    test("merges onto stored values, not inherited defaults", async () => {
      // Set the default first so creating the listing invalidates the cache and
      // the resolving lookup sees the default live.
      await settings.update.listingDefaults({ hidden: true });
      const listing = await createTestListing({
        hidden: false,
        useDefaults: true,
      });
      const resolved = (await getListingWithCount(listing.id))!;
      // The lookup row inherits the default…
      expect(resolved.hidden).toBe(true);
      // …but an update that doesn't touch hidden keeps the listing's stored
      // false, so clearing the default later still restores its own value.
      const result = await bodyToUpdateInput({ name: "Renamed" }, resolved);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hidden).toBe(false);
    });

    test("preserves use_defaults when absent and toggles it when sent", async () => {
      const existing = testListingWithCount({
        max_attendees: 10,
        name: "Inheriting",
        slug: "inheriting",
        use_defaults: true,
      });
      // Omitted → the flag is preserved (an unrelated PUT can't un-inherit it).
      const kept = await bodyToUpdateInput({}, existing);
      expect(kept.ok && kept.value.useDefaults).toBe(true);
      // Explicit false → turned off.
      const off = await bodyToUpdateInput({ use_defaults: false }, existing);
      expect(off.ok && off.value.useDefaults).toBe(false);
    });

    test("preserves existing closes_at null as empty string", async () => {
      const existing = testListingWithCount({
        closes_at: null,
        max_attendees: 10,
        name: "No Closes",
        slug: "no-closes",
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closesAt).toBe("");
      }
    });
  });

  describe("months_per_unit and initial_site_months", () => {
    test("months_per_unit round-trips on save", async () => {
      const listing = await createTestListing({
        hidden: true,
        monthsPerUnit: 3,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.months_per_unit).toBe(3);
    });

    test("initial_site_months round-trips on save", async () => {
      const listing = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 6,
      });
      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.initial_site_months).toBe(6);
    });

    test("months_per_unit > 0 with purchase_only=0 is rejected", async () => {
      await expect(
        createTestListing({
          monthsPerUnit: 1,
          purchaseOnly: false,
        }),
      ).rejects.toThrow();
    });
  });
});
