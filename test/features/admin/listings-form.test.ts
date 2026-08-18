import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  extractListingAggregateValues,
  parseGroupIds,
} from "#routes/admin/listings-form.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { getDb } from "#shared/db/client.ts";
import { getListingDayPrices } from "#shared/db/listing-prices.ts";
import { computeSlugIndex } from "#shared/db/listings/table.ts";
import type { Listing } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";

const listingForm = (extra: TestFormValues = {}) =>
  testFormParams({
    max_attendees: "50",
    max_quantity: "5",
    name: "Parsed listing",
    ...extra,
  });

const createListing = async (extra: TestFormValues = {}): Promise<Listing> => {
  const form = listingForm(extra);
  const result = await buildCreateListingResource(form).create(form);
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.row;
};

const updateListing = async (
  id: number,
  extra: TestFormValues = {},
): Promise<Listing> => {
  const form = listingForm({ slug: "kept-slug", ...extra });
  const result = await buildUpdateListingResource(form).update(id, form);
  if (!result.ok) throw new Error(`update failed: ${result.error}`);
  return result.row;
};

describeWithEnv("listings form", { db: true }, () => {
  describe("parseGroupIds", () => {
    test("keeps only positive whole group ids", () => {
      const form = testFormParams({ group_ids: ["3", "0", "-2", "abc", "7"] });
      expect(parseGroupIds(form)).toEqual([3, 7]);
    });

    test("is empty when no group is ticked", () => {
      expect(parseGroupIds(testFormParams({}))).toEqual([]);
    });
  });

  describe("extractListingAggregateValues", () => {
    test("keeps exactly the two aggregate columns", () => {
      expect(
        extractListingAggregateValues({
          booked_quantity: 7,
          tickets_count: 3,
        }),
      ).toEqual({ booked_quantity: 7, tickets_count: 3 });
    });
  });

  describe("create", () => {
    test("a minimal form makes a free standard listing open on every day", () =>
      (async () => {
        const row = await createListing();
        expect(row.name).toBe("Parsed listing");
        expect(row.listing_type).toBe("standard");
        expect(row.unit_price).toBe(0);
        expect(row.max_attendees).toBe(50);
        expect(row.max_quantity).toBe(5);
        expect(row.bookable_days).toEqual([...VALID_DAY_NAMES]);
        expect(row.closes_at).toBeNull();
      })());

    test("a zero unit price stays an explicit zero", async () => {
      const row = await createListing({ unit_price: "0" });
      expect(row.unit_price).toBe(0);
    });

    test("a priced form stores the currency's minor units", async () => {
      const row = await createListing({
        max_price: "12.5",
        unit_price: "12.34",
      });
      expect(row.unit_price).toBe(1234);
      expect(row.max_price).toBe(1250);
    });

    test("datetimes normalize to UTC, and blanks stay blank", async () => {
      const dated = await createListing({
        closes_at_date: "2026-06-15",
        closes_at_time: "14:30",
        date_date: "2026-03-01",
        date_time: "09:05",
      });
      expect(dated.closes_at).toBe("2026-06-15T14:30:00.000Z");
      expect(dated.date).toBe("2026-03-01T09:05:00.000Z");

      const blank = await createListing({ name: "Undated" });
      expect(blank.closes_at).toBeNull();
      expect(blank.date).toBe("");
    });

    test("chosen bookable days are kept as chosen", async () => {
      const row = await createListing({
        bookable_days: ["Monday", "Thursday"],
      });
      expect(row.bookable_days).toEqual(["Monday", "Thursday"]);
    });

    test("day prices are read for days one up to the duration only", async () => {
      const row = await createListing({
        day_price_1: "10",
        day_price_2: "",
        day_price_3: "30",
        day_price_4: "40",
        duration_days: "3",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1000, 3: 3000 });
    });

    test("without a duration, only the single-day price is read", async () => {
      const row = await createListing({
        day_price_1: "15",
        day_price_2: "20",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1500 });
    });

    test("an unreadable day price rejects the save with a plain message", async () => {
      const form = listingForm({ day_price_1: "abc", duration_days: "2" });
      const result = await buildCreateListingResource(form).create(form);
      expect(result).toEqual({
        error: "Enter a valid day price for each duration, or leave it blank.",
        ok: false,
      });
    });

    test("ticked groups are saved; unticked junk ids are not", async () => {
      const group = await createTestGroup({ name: "Form group" });
      const row = await createListing({
        group_ids: [String(group.id), "0", "-4"],
      });
      const links = await getDb().execute({
        args: [row.id],
        sql: "SELECT group_id FROM group_listings WHERE listing_id = ?",
      });
      expect(links.rows.map((r) => r.group_id)).toEqual([group.id]);
    });

    test("builder and logistics choices stay off while their features are off", async () => {
      const row = await createListing({
        assign_built_site: "1",
        uses_logistics: "1",
      });
      expect(row.assign_built_site).toBe(false);
      expect(row.uses_logistics).toBe(false);
    });

    test("a logistics choice is kept when the feature is on", () =>
      withSetting(featureSetting("logistics"), async () => {
        const on = await createListing({ uses_logistics: "1" });
        expect(on.uses_logistics).toBe(true);
        // An unticked checkbox never reaches the form at all.
        const off = await createListing({ name: "No logistics" });
        expect(off.uses_logistics).toBe(false);
      }));
  });

  describe("update", () => {
    test("the slug is normalized and its lookup code recomputed", async () => {
      const created = await createListing();
      const row = await updateListing(created.id, { slug: "  New-Slug  " });
      expect(row.slug).toBe("new-slug");
      expect(row.slug_index).toBe(await computeSlugIndex("new-slug"));
    });

    test("a daily listing keeps an emptied day selection empty", async () => {
      // A create with no days ticked opens every day by default...
      const created = await createListing({ listing_type: "daily" });
      expect(created.bookable_days).toEqual([...VALID_DAY_NAMES]);
      // ...but a daily update with none ticked means "no days", and stays so.
      const row = await updateListing(created.id, { listing_type: "daily" });
      expect(row.bookable_days).toEqual([]);
    });

    test("a standard listing's emptied day selection reopens every day", async () => {
      const created = await createListing({ bookable_days: ["Monday"] });
      const row = await updateListing(created.id, {});
      expect(row.bookable_days).toEqual([...VALID_DAY_NAMES]);
    });
  });
});
