import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingAttributeOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import { getListingDayPrices } from "#db/listing-prices.ts";
import { computeSlugIndex } from "#db/listings/table.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  extractListingAggregateValues,
  parseGroupIds,
} from "#routes/admin/listings-form.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";
import type { Listing } from "#types";

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
      const form = testFormParams({
        group_ids: ["3", "0", "-2", "abc", "3.5", "Infinity", "7"],
      });
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

    test("a single chosen day stays that one day", async () => {
      const row = await createListing({ bookable_days: ["Friday"] });
      expect(row.bookable_days).toEqual(["Friday"]);
    });

    test("an impossible date is refused before anything is saved", async () => {
      const form = listingForm({ date_date: "2026-02-30", date_time: "10:00" });
      const result = await buildCreateListingResource(form).create(form);
      expect(result).toEqual({
        error: "Please enter a valid date and time",
        ok: false,
      });
    });

    test("a listing with no closing date stores nothing in that column", async () => {
      const row = await createListing();
      const stored = await getDb().execute({
        args: [row.id],
        sql:
          "SELECT listing.closes_at FROM listings AS listing " +
          "WHERE listing.id = ?",
      });
      expect(stored.rows[0]!.closes_at).toBeNull();
    });

    test("the use-defaults tick is saved", async () => {
      const on = await createListing({ use_defaults: "1" });
      expect(on.use_defaults).toBe(true);

      const off = await createListing({ name: "Own values" });
      expect(off.use_defaults).toBe(false);
    });

    test("demo mode drops the webhook address, normal mode keeps it", async () => {
      const hook = "https://example.com/hook";
      const real = await createListing({ webhook_url: hook });
      expect(real.webhook_url).toBe(hook);

      setDemoModeForTest(true);
      try {
        const demo = await createListing({
          name: "Demo listing",
          webhook_url: hook,
        });
        expect(demo.webhook_url).toBe("");
      } finally {
        setDemoModeForTest(false);
      }
    });

    test("duplicating a listing copies the source's attribute choices", async () => {
      const attribute = await createTestAttributeWithOptions("Size", [
        "Small",
        "Large",
      ]);
      const source = await createListing({ name: "Source" });
      await assignTestAttributeOptions(source.id, attribute.options);

      const copy = await createListing({
        duplicated_from: String(source.id),
        name: "Copy",
      });
      expect(await listingAttributeOptions.getIds(copy.id)).toEqual(
        attribute.options.map((option) => option.id),
      );

      const fresh = await createListing({ name: "Fresh" });
      expect(await listingAttributeOptions.getIds(fresh.id)).toEqual([]);
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
        sql:
          "SELECT groupListing.group_id FROM group_listings AS groupListing " +
          "WHERE groupListing.listing_id = ?",
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

    test("clearing the price on an update stores a real zero", async () => {
      const created = await createListing({ unit_price: "12.34" });
      expect(created.unit_price).toBe(1234);

      const row = await updateListing(created.id, { unit_price: "0" });
      expect(row.unit_price).toBe(0);
      // A real stored zero, not an absent value: the column is what the base
      // price row is mirrored from.
      const stored = await getDb().execute({
        args: [row.id],
        sql:
          "SELECT listing.unit_price FROM listings AS listing " +
          "WHERE listing.id = ?",
      });
      expect(stored.rows[0]!.unit_price).toBe(0);
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
