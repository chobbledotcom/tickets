import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { submitListingCreate } from "#test-utils/listing-submits.ts";
import { adminMultipartPost } from "#test-utils/session.ts";

/** Post the create form with the base boxes plus the given ones, check the
 *  answer's status, and return the page text and the stored listing. */
const createAnswer = async (status: number, boxes: TestFormValues) => {
  const { response } = await submitListingCreate(boxes);
  expect(response.status).toBe(status);
  return { listing: await getListingWithCount(1), text: await response.text() };
};

/** A refused create shows the message and stores nothing. */
const expectRefusedCreate = async (
  boxes: TestFormValues,
  message: string,
): Promise<string> => {
  const { listing, text } = await createAnswer(400, boxes);
  assertStringIncludes(text, message);
  expect(listing).toBeNull();
  return text;
};

describeWithEnv("server listings > create validation", { db: true }, () => {
  describe("POST /admin/listing with unit_price", () => {
    test("creates listing with unit_price when authenticated", async () => {
      const { listing } = await createAnswer(302, {
        name: "Paid Listing",
        unitPrice: "10.00",
      });
      expect(listing?.unitPrice).toBe(1000);
    });

    test("refuses a blank unit_price and asks for 0 for a free listing", async () => {
      await expectRefusedCreate(
        { name: "Free Listing", unitPrice: "" },
        "Enter a ticket price. Type 0 for free.",
      );
    });
  });
  describe("POST /admin/listing day-price validation", () => {
    test("rejects a create when a day price is over-precise for the currency", async () => {
      // 10.005 has 3 decimals — invalid in GBP (2). Without validation this
      // would be silently dropped; instead the save is rejected.
      await expectRefusedCreate(
        { dayPrice1: "10.005", name: "Bad Day Price" },
        "valid day price",
      );
    });

    test("keeps repeated bookable days after a rejected create", async () => {
      const html = await expectRefusedCreate(
        {
          bookableDays: ["Monday", "Wednesday"],
          dayPrice1: "10.005",
          listingType: "daily",
          name: "Bad Day Price",
        },
        "valid day price",
      );
      expectIncludesAll(html, [
        'value="Monday" checked',
        'value="Wednesday" checked',
      ]);
    });

    test("accepts a create with a valid day price and stores it", async () => {
      const { listing } = await createAnswer(302, {
        dayPrice1: "10.00",
        name: "Good Day Price",
      });
      expect(listing?.dayPrices).toEqual({ 1: 1000 });
    });
  });
  describe("POST /admin/listing with can_pay_more", () => {
    test("creates listing with can_pay_more enabled", async () => {
      const { listing } = await createAnswer(302, {
        canPayMore: "1",
        name: "Pay More Listing",
        unitPrice: "10.00",
      });
      expect([listing?.canPayMore, listing?.unitPrice]).toEqual([true, 1000]);
    });

    test("creates listing with can_pay_more disabled by default", async () => {
      const { listing } = await createAnswer(302, {
        name: "Normal Listing",
        unitPrice: "5.00",
      });
      expect(listing?.canPayMore).toBe(false);
    });

    test("updates listing can_pay_more via edit", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });

      const { response } = await adminMultipartPost(
        `/admin/listing/${listing.id}/edit`,
        {
          canPayMore: "1",
          maxAttendees: String(listing.maxAttendees),
          maxQuantity: String(listing.maxQuantity),
          name: listing.name,
          slug: listing.slug,
          unitPrice: "10.00",
        },
      );
      expect(response.status).toBe(302);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.canPayMore).toBe(true);
    });
  });
  describe("POST /admin/listing with max_price", () => {
    test("creates listing with max_price", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        maxPrice: 50000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.maxPrice).toBe(50000);
      expect(saved?.canPayMore).toBe(true);
    });

    test("max_price defaults to 10000 when not set", async () => {
      const listing = await createTestListing({ canPayMore: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.maxPrice).toBe(10000);
    });

    test("rejects max_price less than unit_price + 100 when can_pay_more", async () => {
      await expectRefusedCreate(
        {
          canPayMore: "1",
          maxPrice: "10.50",
          name: "Bad Max Price",
          unitPrice: "10.00",
        },
        "Maximum price must be at least £1 more than the ticket price",
      );
    });

    test("allows max_price less than unit_price + 100 when can_pay_more is off", async () => {
      const listing = await createTestListing({
        maxPrice: 1050,
        unitPrice: 1000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.maxPrice).toBe(1050);
    });

    test("accepts max_price equal to unit_price + 100", async () => {
      const listing = await createTestListing({
        maxPrice: 1100,
        unitPrice: 1000,
      });
      expect(listing.maxPrice).toBe(1100);
    });

    test("updates max_price via edit", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        unitPrice: 1000,
      });
      await updateTestListing(listing.id, { maxPrice: 25000 });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.maxPrice).toBe(25000);
    });
  });
});
