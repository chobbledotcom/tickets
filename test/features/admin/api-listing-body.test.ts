import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import {
  bodyToCreateInput,
  bodyToUpdateInput,
} from "#routes/admin/api-listing-body.ts";
import { requireSuccess } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("bodyToCreateInput", () => {
    /** A create body the API refuses, and the exact refusal it answers. */
    type CreateRefusal = {
      label: string;
      body: Record<string, unknown>;
      error: string;
    };

    /** A body with a valid name and capacity, plus the fields under test. */
    const listingBody = (
      name: string,
      extra: Record<string, unknown>,
    ): Record<string, unknown> => ({ max_attendees: 10, name, ...extra });

    const badDayPrices = (
      label: string,
      dayPrices: unknown,
    ): CreateRefusal => ({
      body: listingBody("Bad Prices", { day_prices: dayPrices }),
      error: "day_prices has an invalid value",
      label,
    });

    // The listing datetimes are UTC instants whose date half must be a real
    // calendar day: the shared real-day rule runs at the JSON boundary.
    const badDate = (name: string, date: string): CreateRefusal => ({
      body: listingBody(name, { closes_at: "2026-06-14T23:59:00Z", date }),
      error: "date must be a UTC instant of a real calendar day",
      label: `refuses an unusable date: ${name}`,
    });

    const createRefusals: CreateRefusal[] = [
      {
        body: { max_attendees: 10, name: 123 },
        error: "name must be a string",
        label: "returns error for non-string name",
      },
      {
        body: listingBody("  ", {}),
        error: "name cannot be empty",
        label: "returns error for a whitespace-only name",
      },
      {
        body: { name: "Test" },
        error: "max_attendees is required",
        label: "returns error for missing max_attendees",
      },
      {
        body: listingBody("Test", { max_attendees: 0 }),
        error: "max_attendees has an invalid value",
        label: "returns error when max_attendees is zero",
      },
      {
        body: listingBody("Test", { bookable_days: ["Monday", 2] }),
        error: "bookable_days has an invalid value",
        label: "rejects non-text bookable days",
      },
      {
        body: listingBody("Test", { duration_days: "3" }),
        error: "duration_days must be a whole number from 1 to 90",
        label: "rejects a text duration",
      },
      badDate("Unpadded", "2026-6-15T10:00:00Z"),
      badDate("Rollover", "2026-02-30T10:00:00Z"),
      badDate("Wording", "soon"),
      badDate("Outside clock", "2026-06-15T99:99:99Z"),
      {
        body: listingBody("Surplus segment", {
          closes_at: "2026-06-15T10:00:00ZTextra",
          date: "2026-06-15T10:00:00Z",
        }),
        error: "closes_at must be a UTC instant of a real calendar day",
        label: "refuses a closing time with a surplus segment",
      },
      {
        body: listingBody("Bad Groups", { group_ids: "5" }),
        error: "group_ids must be an array",
        label: "rejects a non-array group_ids",
      },
      {
        body: listingBody("Bad Entry", { group_ids: ["5"] }),
        error: "group_ids must contain only positive integer ids",
        label: "rejects group_ids with non-positive-integer entries",
      },
      badDayPrices("refuses a negative day price", { 1: -5 }),
      badDayPrices("refuses a text day price", { 1: "500" }),
      badDayPrices("refuses day prices given as an array", [500]),
      badDayPrices("refuses day prices given as text", "500"),
      badDayPrices("rejects unsafe day prices", {
        1: Number.MAX_SAFE_INTEGER + 1,
      }),
    ];

    for (const { body, error, label } of createRefusals) {
      test(label, async () => {
        expect(await bodyToCreateInput(body)).toEqual({ error, ok: false });
      });
    }

    test("handles all field types correctly", async () => {
      const value = requireSuccess(
        await bodyToCreateInput({
          active: false,
          bookable_alone: true,
          bookable_days: ["Monday"],
          closes_at: "2026-06-14T23:59:00Z",
          date: "2026-06-15T10:00:00Z",
          day_prices: { 1: 0, 2: 1200 },
          duration_days: 3,
          max_attendees: 10,
          max_price: 5000,
          name: "Test",
        }),
      );

      expect(value.active).toBe(false);
      expect(value.bookableAlone).toBe(true);
      expect(value.bookableDays).toEqual(["Monday"]);
      expect(value.date).toBe("2026-06-15T10:00:00Z");
      expect(value.dayPrices).toEqual({ 1: 0, 2: 1200 });
      expect(value.durationDays).toBe(3);
      expect(value.maxPrice).toBe(5000);
      expect(value.slug).toMatch(/^[0-9a-h]{5}$/);
    });

    test("maps every supported scalar without changing neutral values", async () => {
      // Each row: the body key, the value sent, and the read value when the
      // read changes it. The read key is the camelCase body key.
      const rows: [string, unknown, unknown?][] = [
        ["active", false],
        ["bookable_alone", true],
        ["bookable_days", []],
        ["can_pay_more", false],
        ["closes_at", null, ""],
        ["customisable_days", true],
        ["date", null, ""],
        ["day_prices", { 1: 0, 2: 2500 }],
        ["description", "Description"],
        ["duration_days", 2],
        ["fields", ""],
        ["group_ids", [1, 3]],
        ["hidden", true],
        ["listing_type", "daily"],
        ["location", "Location"],
        ["max_attendees", 25],
        ["max_price", 0],
        ["max_quantity", 1],
        ["maximum_days_after", 0],
        ["min_quantity", 2],
        ["minimum_days_before", 0],
        ["name", "  Full listing  ", "Full listing"],
        ["non_transferable", true],
        ["thank_you_url", ""],
        ["unit_price", 0],
        ["use_defaults", false],
        ["webhook_url", ""],
      ];
      const camel = (key: string) =>
        key.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());
      const result = await bodyToCreateInput(
        Object.fromEntries(rows.map(([key, sent]) => [key, sent])),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { slug, slugIndex, ...input } = result.value;
        expect(input).toEqual({
          ...Object.fromEntries(
            rows.map(([key, sent, ...read]) => [
              camel(key),
              read.length > 0 ? read[0] : sent,
            ]),
          ),
          // The fields the body left out read as their declared defaults.
          assignBuiltSite: false,
          purchaseOnly: false,
          recurringInterval: "",
          usesLogistics: false,
        });
        expect(slug).toMatch(/^[0-9a-h]{5}$/);
        expect(slugIndex).toHaveLength(44);
      }
    });

    test("accepts the stored blank frequency while subscriptions are on", () =>
      withSetting(featureSetting("subscriptions"), async () => {
        const value = requireSuccess(
          await bodyToCreateInput(
            listingBody("Ordinary", { recurring_interval: "" }),
          ),
        );
        expect(value.recurringInterval).toBe("");
      }));

    test("defaults max_price to zero", async () => {
      const value = requireSuccess(
        await bodyToCreateInput(listingBody("No Maximum Price", {})),
      );
      expect(value.maxPrice).toBe(0);
    });

    test("maps the use_defaults flag both ways and turns it off when absent", async () => {
      // true/false both round-trip (so the API can opt in *and* out), and an
      // absent flag on create takes the column default, off.
      const cases: [boolean | undefined, boolean][] = [
        [true, true],
        [false, false],
        [undefined, false],
      ];
      for (const [sent, expected] of cases) {
        const body = listingBody("Inheriting", {});
        if (sent !== undefined) body.use_defaults = sent;
        const value = requireSuccess(await bodyToCreateInput(body));
        expect(value.useDefaults).toBe(expected);
      }
    });
  });

  describe("bodyToUpdateInput", () => {
    test("rejects a maximum attendee count below one or beyond the safe integer range", async () => {
      // Number.isInteger passes 1e100: the stored column could never hold a
      // capacity whose neighbours JavaScript cannot tell apart.
      for (const maxAttendees of [0, 1e100]) {
        expect(
          await bodyToUpdateInput(
            { max_attendees: maxAttendees },
            testListingWithCount({ maxAttendees: 10 }),
          ),
        ).toEqual({ error: "max_attendees has an invalid value", ok: false });
      }
    });

    test("uses supplied prices, a zero maximum price included, and groups", async () => {
      const result = await bodyToUpdateInput(
        {
          day_prices: { 2: 2_000 },
          group_ids: [7],
          max_price: 0,
        },
        testListingWithCount({
          dayPrices: { 1: 1_000 },
          maxAttendees: 10,
          maxPrice: 4_000,
        }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.dayPrices).toEqual({ 2: 2_000 });
        expect(result.value.groupIds).toEqual([7]);
        expect(result.value.maxPrice).toBe(0);
      }
    });

    test("takes a supplied name, trimmed", async () => {
      const result = await bodyToUpdateInput(
        { name: " Renamed " },
        testListingWithCount({ maxAttendees: 10, name: "Old" }),
      );
      expect(result.ok && result.value.name).toBe("Renamed");
    });

    test("rejects malformed group_ids instead of silently clearing membership", async () => {
      const existing = testListingWithCount({
        maxAttendees: 10,
        name: "Has Groups",
        slug: "has-groups",
      });
      expect(await bodyToUpdateInput({ group_ids: ["5"] }, existing)).toEqual({
        error: "group_ids must contain only positive integer ids",
        ok: false,
      });
    });

    test("preserves existing values when fields not provided", async () => {
      const existing = testListingWithCount({
        bookableDays: ["Monday"],
        closesAt: "2026-01-02T00:00:00.000Z",
        date: "2026-01-01T00:00:00.000Z",
        description: "Existing desc",
        location: "Old Place",
        maxAttendees: 50,
        maximumDaysAfter: 90,
        maxQuantity: 2,
        minimumDaysBefore: 1,
        name: "Existing",
        slug: "existing-slug",
        thankYouUrl: "https://old.com/thanks",
        unitPrice: 100,
        webhookUrl: "https://old.com/hook",
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
        maxAttendees: 10,
        name: "Inheriting",
        slug: "inheriting",
        useDefaults: true,
      });
      // Omitted → the flag is preserved (an unrelated PUT can't un-inherit it).
      const kept = await bodyToUpdateInput({}, existing);
      expect(kept).toMatchObject({ ok: true, value: { useDefaults: true } });
      // Explicit false → turned off.
      const off = await bodyToUpdateInput({ use_defaults: false }, existing);
      expect(off).toMatchObject({ ok: true, value: { useDefaults: false } });
    });

    test("leaves an unset closing time out of an update that omits it", async () => {
      const existing = testListingWithCount({
        closesAt: null,
        maxAttendees: 10,
        name: "No Closes",
        slug: "no-closes",
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok && Object.hasOwn(result.value, "closesAt")).toBe(false);
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
      expect(fetched?.monthsPerUnit).toBe(3);
    });

    test("initial_site_months round-trips on save", async () => {
      const listing = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 6,
      });
      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.initialSiteMonths).toBe(6);
    });

    test("months_per_unit > 0 with purchase_only=0 is rejected", async () => {
      await expect(
        createTestListing({
          monthsPerUnit: 1,
          purchaseOnly: false,
        }),
      ).rejects.toThrow();
    });

    test("the body sets the site building fields while site building is on", async () => {
      using _builder = withEnv({ CAN_BUILD_SITES: "true" });
      const plan = { assign_built_site: true, initial_site_months: 6 };
      const created = requireSuccess(
        await bodyToCreateInput({
          max_attendees: 10,
          months_per_unit: 3,
          name: "Plan",
          purchase_only: true,
          ...plan,
        }),
      );
      expect([
        created.assignBuiltSite,
        created.initialSiteMonths,
        created.monthsPerUnit,
        created.purchaseOnly,
      ]).toEqual([true, 6, 3, true]);
    });
  });
});
