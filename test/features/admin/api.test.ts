import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
import { t } from "#i18n";
import {
  expectApiErrorIncludes,
  expectApiRecord,
  type JsonBody,
  postJson,
  putJson,
} from "#test-utils/api/admin-json.ts";
import {
  assertAdminHtml,
  expectApiError,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import { apiRequest, createTestApiKeyToken } from "#test-utils/session.ts";

/** The path of one listing in the admin API. */
const listingPath = (id: number | string): string =>
  `/api/admin/listings/${id}`;

/** The listing that an admin API answer holds. */
const expectListing = expectApiRecord("listing");

/** Change a new listing through the admin API and check the listing that the
 *  answer holds. */
const expectListingChange = async (
  fields: TestListingOverrides,
  changes: JsonBody,
  check: (listing: JsonBody) => void = () => {},
) => {
  const listing = await createTestListing(fields);
  await expectListing(putJson(listingPath(listing.id), changes), 200, check);
  return listing;
};

/** Assert that the admin API refuses a change to a new listing with
 *  `message`. */
const expectChangeRefused = async (
  name: string,
  changes: JsonBody,
  message: string,
): Promise<void> => {
  const listing = await createTestListing({ name });
  await expectApiError(putJson(listingPath(listing.id), changes), 400, message);
};

/** Set a value on a new listing, clear it with null, and give back the
 *  listing that the clearing answer holds. */
const setThenClear = async (
  name: string,
  field: string,
  value: string,
): Promise<JsonBody> => {
  const listing = await createTestListing({ name });
  const apiKey = await createTestApiKeyToken();
  const send = (body: JsonBody) =>
    apiRequest(listingPath(listing.id), { apiKey, body, method: "PUT" });

  await send({ [field]: value });
  return expectListing(send({ [field]: null }), 200);
};

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("PUT /api/admin/listings/:listingId", () => {
    test("updates listing name", async () => {
      const listing = await createTestListing({ name: "Original" });

      await expectListing(
        putJson(listingPath(listing.id), { name: "Updated Name" }),
        200,
        (row) => {
          expect(row.name).toBe("Updated Name");
          expect(row.id).toBe(listing.id);
        },
      );
    });

    test("updates listing with partial fields", async () => {
      await expectListingChange(
        { maxAttendees: 50, name: "Partial Update" },
        { description: "Updated desc", max_attendees: 100 },
        (row) => {
          expect(row.name).toBe("Partial Update");
          expect(row.max_attendees).toBe(100);
          expect(row.description).toBe("Updated desc");
        },
      );
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await putJson(listingPath(99999), { name: "Ghost" });

      expect(response.status).toBe(404);
    });

    test("returns 404 when the listing vanishes during update", async () => {
      const listing = await createTestListing({ name: "Vanishing listing" });
      await getDb().execute(
        sql`CREATE TRIGGER delete_listing_during_update
         AFTER UPDATE ON listings
         WHEN NEW.id = ${sqlLiteral(listing.id)}
         BEGIN
           DELETE FROM listings WHERE id = NEW.id;
         END`,
      );

      const response = await putJson(listingPath(listing.id), {
        name: "Gone",
      });

      expect(response.status).toBe(404);
    });

    test("returns 400 when name is empty string", async () => {
      const listing = await createTestListing({ name: "Will Empty" });
      await expectRejectsEmptyName(listingPath(listing.id));
    });

    test("returns 400 when a bookable day is not text", async () => {
      await expectChangeRefused(
        "Named Days",
        { bookable_days: ["Monday", 2] },
        "bookable_days has an invalid value",
      );
    });

    test("returns 400 when a linked id list is malformed", async () => {
      const listing = await createTestListing({ name: "Bad Id Lists" });
      const cases = [
        {
          body: { attribute_option_ids: ["5"] },
          error: "attribute_option_ids must contain only positive integer ids",
        },
        {
          body: { child_listing_ids: "5" },
          error: "child_listing_ids must be an array of listing ids",
        },
        {
          body: { group_ids: [0] },
          error: "group_ids must contain only positive integer ids",
        },
      ];
      for (const { body, error } of cases) {
        await expectApiError(
          putJson(listingPath(listing.id), body),
          400,
          error,
        );
      }
    });

    test("returns 400 without saving an unsafe day price", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        durationDays: 2,
        name: "Safe Prices",
      });
      await expectApiError(
        putJson(listingPath(listing.id), {
          day_prices: { 1: Number.MAX_SAFE_INTEGER + 1 },
        }),
        400,
        "day_prices has an invalid value",
      );
      expect((await getListingWithCount(listing.id))?.dayPrices).toEqual({
        1: 500,
      });
    });

    test("rejects duplicate slug", async () => {
      const listing1 = await createTestListing({ name: "Listing One" });

      // Use listing1's slug for listing2
      await expectChangeRefused(
        "Listing Two",
        { slug: listing1.slug },
        "Slug is already in use by another listing",
      );
    });

    test("allows keeping the same slug", async () => {
      const listing = await createTestListing({ name: "Keep Slug" });

      await expectListing(
        putJson(listingPath(listing.id), {
          name: "Renamed",
          slug: listing.slug,
        }),
        200,
        (row) => expect(row.name).toBe("Renamed"),
      );
    });

    test("links an update to the listing activity page", async () => {
      const listing = await expectListingChange(
        { name: "Activity before" },
        { name: "Activity after" },
      );

      await assertAdminHtml(
        `/admin/listing/${listing.id}/activity`,
        "Listing 'Activity after' updated",
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId - comprehensive field updates", () => {
    test("updates all fields on an listing", async () => {
      await expectListingChange(
        { name: "Full Update" },
        {
          active: true,
          bookable_days: ["Monday", "Wednesday", "Friday"],
          can_pay_more: true,
          closes_at: "2026-12-24T23:59:00Z",
          date: "2026-12-25T18:00:00Z",
          description: "New desc",
          fields: "email,phone,address",
          group_ids: [],
          hidden: true,
          listing_type: "daily",
          location: "New Location",
          max_attendees: 200,
          max_price: 5000,
          max_quantity: 10,
          maximum_days_after: 30,
          minimum_days_before: 3,
          name: "Fully Updated",
          non_transferable: true,
          thank_you_url: "https://new.example.com/thanks",
          unit_price: 1000,
          webhook_url: "https://new.example.com/hook",
        },
        (row) => {
          expect(row).toMatchObject({
            bookable_days: ["Monday", "Wednesday", "Friday"],
            can_pay_more: true,
            hidden: true,
            listing_type: "daily",
            location: "New Location",
            max_attendees: 200,
            max_quantity: 10,
            maximum_days_after: 30,
            minimum_days_before: 3,
            name: "Fully Updated",
            non_transferable: true,
            unit_price: 1000,
          });
        },
      );
    });

    test("updates customisable_days and day_prices", async () => {
      await expectListingChange(
        { durationDays: 2, name: "To Flex" },
        {
          customisable_days: true,
          day_prices: { 1: 500, 2: 900 },
          duration_days: 2,
        },
        (row) => {
          expect(row.customisable_days).toBe(true);
          expect(row.day_prices).toEqual({ 1: 500, 2: 900 });
        },
      );
    });

    test("a PUT that omits day_prices leaves the existing day_count rows intact", async () => {
      // A partial update touching only the name must not wipe the day prices —
      // the JSON API defaults day_prices to the existing value and re-writes it.
      await expectListingChange(
        {
          customisableDays: true,
          dayPrices: { 1: 400, 2: 700 },
          durationDays: 3,
          name: "Keep Days",
        },
        { name: "Kept Days" },
        (row) => {
          expect(row.name).toBe("Kept Days");
          expect(row.day_prices).toEqual({ 1: 400, 2: 700 });
        },
      );
    });

    test("clears date by setting it to null", async () => {
      const row = await setThenClear(
        "Clear Date",
        "date",
        "2026-06-15T10:00:00Z",
      );
      expect(row.date).toBe("");
    });

    test("clears closes_at by setting it to null", async () => {
      const row = await setThenClear(
        "Clear Closes",
        "closes_at",
        "2026-06-14T23:59:00Z",
      );
      expect(row.closes_at).toBeNull();
    });

    test("returns 400 for max_attendees less than 1", async () => {
      await expectChangeRefused(
        "Bad Max",
        { max_attendees: 0 },
        "max_attendees has an invalid value",
      );
    });

    test("returns 400 for a fractional max_attendees", async () => {
      // A stored 2.5 would flow into maxPurchasable as a fractional ceiling,
      // and the combined-capacity search answers in whole places.
      await expectChangeRefused(
        "Bad Max",
        { max_attendees: 2.5 },
        "max_attendees has an invalid value",
      );
    });

    test("validates can_pay_more max_price on update", async () => {
      const listing = await createTestListing({ name: "Pay More Update" });

      await expectApiErrorIncludes(
        putJson(listingPath(listing.id), {
          can_pay_more: true,
          max_price: 500,
          unit_price: 500,
        }),
        400,
        "Maximum price",
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId - validation errors", () => {
    test("rejects update with invalid group", async () => {
      await expectChangeRefused(
        "Update Group",
        { group_ids: [99999] },
        t("error.selected_group_deleted"),
      );
    });

    test("rejects update with mismatched group listing type", async () => {
      const group = await createTestGroup({ name: "Update Type Group" });

      // Create a standard listing in the group
      await postJson("/api/admin/listings", {
        group_ids: [group.id],
        listing_type: "standard",
        max_attendees: 10,
        name: "Standard First",
      });

      // Create a separate listing and try to add it as daily to same group
      const listing = await createTestListing({ name: "Move To Group" });

      await expectApiErrorIncludes(
        putJson(listingPath(listing.id), {
          group_ids: [group.id],
          listing_type: "daily",
        }),
        400,
        "same type",
      );
    });
  });
});
