// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminMultipartPost } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > create validation", { db: true }, () => {
  describe("POST /admin/listing with unit_price", () => {
    test("creates listing with unit_price when authenticated", async () => {
      const { response } = await adminFormPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Paid Listing",
        thank_you_url: "https://example.com/thanks",
        unit_price: "10.00",
      });
      expect(response.status).toBe(302);
    });

    test("creates a free listing when unit_price is blank (no price)", async () => {
      // Exercises the optional-price parse's blank path: a blank unit_price
      // resolves to no price, and the listing stores 0 (free).
      const { response } = await adminFormPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Free Listing",
        thank_you_url: "https://example.com/thanks",
        unit_price: "",
      });
      expect(response.status).toBe(302);
      expect((await getListingWithCount(1))?.unit_price).toBe(0);
    });
  });
  describe("POST /admin/listing day-price validation", () => {
    test("rejects a create when a day price is over-precise for the currency", async () => {
      // 10.005 has 3 decimals — invalid in GBP (2). Without validation this
      // would be silently dropped; instead the save is rejected.
      const { response } = await adminFormPost("/admin/listing", {
        day_price_1: "10.005",
        max_attendees: "50",
        max_quantity: "1",
        name: "Bad Day Price",
        thank_you_url: "https://example.com/thanks",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("valid day price");
      // Nothing was created.
      expect(await getListingWithCount(1)).toBeNull();
    });

    test("accepts a create with a valid day price and stores it", async () => {
      const { response } = await adminFormPost("/admin/listing", {
        day_price_1: "10.00",
        max_attendees: "50",
        max_quantity: "1",
        name: "Good Day Price",
        thank_you_url: "https://example.com/thanks",
      });
      expect(response.status).toBe(302);
      expect((await getListingWithCount(1))?.day_prices).toEqual({ 1: 1000 });
    });
  });
  describe("POST /admin/listing with can_pay_more", () => {
    test("creates listing with can_pay_more enabled", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        can_pay_more: "1",
        max_attendees: "50",
        max_quantity: "1",
        name: "Pay More Listing",
        unit_price: "10.00",
      });
      expect(response.status).toBe(302);

      const listing = await getListingWithCount(1);
      expect(listing?.can_pay_more).toBe(true);
      expect(listing?.unit_price).toBe(1000);
    });

    test("creates listing with can_pay_more disabled by default", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Normal Listing",
        unit_price: "5.00",
      });
      expect(response.status).toBe(302);

      const listing = await getListingWithCount(1);
      expect(listing?.can_pay_more).toBe(false);
    });

    test("updates listing can_pay_more via edit", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });

      const { response } = await adminMultipartPost(
        `/admin/listing/${listing.id}/edit`,
        {
          can_pay_more: "1",
          max_attendees: String(listing.max_attendees),
          max_quantity: String(listing.max_quantity),
          name: listing.name,
          slug: listing.slug,
          unit_price: "10.00",
        },
      );
      expect(response.status).toBe(302);

      const updated = await getListingWithCount(listing.id);
      expect(updated?.can_pay_more).toBe(true);
    });
  });
  describe("POST /admin/listing with max_price", () => {
    test("creates listing with max_price", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        maxPrice: 50000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(50000);
      expect(saved?.can_pay_more).toBe(true);
    });

    test("max_price defaults to 10000 when not set", async () => {
      const listing = await createTestListing({ canPayMore: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(10000);
    });

    test("rejects max_price less than unit_price + 100 when can_pay_more", async () => {
      const { response } = await adminMultipartPost("/admin/listing", {
        can_pay_more: "1",
        max_attendees: "50",
        max_price: "10.50",
        max_quantity: "1",
        name: "Bad Max Price",
        unit_price: "10.00",
      });
      await expectHtmlResponse(
        response,
        400,
        "Maximum price must be at least £1 more than the ticket price",
      );
    });

    test("allows max_price less than unit_price + 100 when can_pay_more is off", async () => {
      const listing = await createTestListing({
        maxPrice: 1050,
        unitPrice: 1000,
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.max_price).toBe(1050);
    });

    test("accepts max_price equal to unit_price + 100", async () => {
      const listing = await createTestListing({
        maxPrice: 1100,
        unitPrice: 1000,
      });
      expect(listing.max_price).toBe(1100);
    });

    test("updates max_price via edit", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        unitPrice: 1000,
      });
      await updateTestListing(listing.id, { maxPrice: 25000 });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.max_price).toBe(25000);
    });
  });
});
