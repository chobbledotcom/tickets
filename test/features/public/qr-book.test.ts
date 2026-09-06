/**
 * Tests for the QR-book scan handler and its price-override plumbing.
 *
 * Covers three behaviours:
 *  - Error paths (missing/invalid/expired token, unknown listing)
 *  - Pre-fill rendering when the listing still needs user input
 *  - Skip-to-Stripe when all required data is carried in the signed token
 *  - Price override on POST for fixed-price listings
 *
 * Sits beside the story `@story:bookings.booking-from-a-code-on-the-door`: these
 * own the branch cover, and the cases needing a fake clock or a hand-signed
 * token the organiser's page would never produce.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import {
  buildQrBookPayload,
  QR_TOKEN_MAX_AGE_S,
  signQrBookToken,
} from "#shared/qr-token.ts";
import { todayInTz } from "#shared/timezone.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockRequest } from "#test-utils/mocks.ts";
import {
  bookToken,
  expectStripeRedirect,
  qrBookPath,
  scanRequest,
  scanWithCheckoutResult,
  scanWithStripe,
  withStripe,
} from "./qr-book/helpers.ts";

describeWithEnv("QR booking", { db: true }, () => {
  describe("error paths", () => {
    test("missing ?t= token renders the error page", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}/qr-book`),
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("expired or invalid");
      expect(body).toContain(`/ticket/${listing.slug}`);
    });

    test("unknown listing slug renders the error page", async () => {
      const token = await signQrBookToken(
        "unknown-slug",
        buildQrBookPayload({ name: "Ada" }),
      );
      const response = await awaitTestRequest(
        qrBookPath("unknown-slug", token),
      );
      expect(response.status).toBe(404);
    });

    test("expired token renders the error page", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      using time = new FakeTime(1_700_000_000_000);
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", value: 500 }),
      );
      time.tick((QR_TOKEN_MAX_AGE_S + 30) * 1000);
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      expect(response.status).toBe(400);
    });

    test("daily listing with an un-bookable date is rejected", async () => {
      const listing = await createDailyTestListing({ unitPrice: 500 });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ date: "1999-01-01", name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      expect(response.status).toBe(400);
    });

    test("daily listing with no date in the token is rejected", async () => {
      const listing = await createDailyTestListing({ unitPrice: 500 });
      const response = await scanRequest(listing, { name: "Ada", value: 500 });
      expect(response.status).toBe(400);
    });
  });

  describe("pre-fill rendering", () => {
    test("pre-fills custom_price input for can_pay_more listings", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        fields: "email",
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", value: 2500 }),
      );
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      const body = await response.text();
      expect(
        hasInputWithValue(body, `custom_price_${listing.id}`, "25.00"),
      ).toBe(true);
    });

    test("pre-fills a signed zero price for can_pay_more listings", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        fields: "email",
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 0,
      });
      const response = await scanRequest(listing, {
        name: "Ada",
        value: 0,
      });
      const body = await response.text();

      expect(
        hasInputWithValue(body, `custom_price_${listing.id}`, "0.00"),
      ).toBe(true);
    });

    test("pre-fills quantity for the listing row", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", quantity: 3, value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      const body = await response.text();
      expect(body).toMatch(/<option value="3"\s+selected>/);
    });

    test("pre-fills the daily date selector", async () => {
      const listing = await createDailyTestListing({
        fields: "email",
        unitPrice: 500,
      });
      const tomorrow = addDays(todayInTz(settings.timezone), 1);
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ date: tomorrow, name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      const body = await response.text();
      expect(body).toMatch(new RegExp(`value="${tomorrow}"\\s+selected`));
    });
  });

  describe("skip-to-Stripe", () => {
    test("renders the booking form (never direct checkout) for a customisable listing", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        fields: "",
        maxAttendees: 10,
      });
      await scanWithStripe(listing, async ({ response, stripe }) => {
        // The visitor must choose a day count, so the form renders instead.
        expect(response.status).toBe(200);
        expect(stripe.calls()).toBe(0);
        expect(await response.text()).toContain('name="day_count"');
      });
    });

    test("accepts an individually-bookable date for a customisable daily listing", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        fields: "",
        listingType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({
          date: addDays(todayInTz("UTC"), 5),
          name: "Ada",
          value: 1000,
        }),
      );
      await withStripe(async () => {
        const response = await awaitTestRequest(
          qrBookPath(listing.slug, token),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('name="day_count"');
      });
    });

    test("renders the error page when the provider cannot create a session", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const response = await scanWithCheckoutResult(listing, null);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        "Failed to create payment session. Please try again.",
      );
    });

    test("returns a provider validation refusal with its HTTP 400 status", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const refusal =
        "The payment processor rejected the phone number as invalid. Please correct it and try again.";
      const response = await scanWithCheckoutResult(listing, {
        error: refusal,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(refusal);
    });

    test("falls through when name is missing even though value is set", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ value: 1000 }),
      );
      await withStripe(async (stripe) => {
        const response = await awaitTestRequest(
          qrBookPath(listing.slug, token),
        );
        expect(response.status).toBe(200);
        expect(stripe.calls()).toBe(0);
      });
    });

    test("falls through when value is missing even though name is set", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });

      await scanWithStripe(
        listing,
        async ({ response, stripe }) => {
          expect(response.status).toBe(200);
          expect(stripe.calls()).toBe(0);
        },
        { name: "Ada" },
      );
    });

    test("a signed zero value skips to checkout", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });

      await scanWithStripe(
        listing,
        async ({ response, stripe }) => {
          expectStripeRedirect(response, stripe);
          expect(stripe.getCaptured()!.items[0]!.unitPrice).toBe(0);
        },
        { name: "Ada", value: 0 },
      );
    });

    test("daily listing with a bookable date skips straight to Stripe with the date set", async () => {
      const listing = await createDailyTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const tomorrow = addDays(todayInTz(settings.timezone), 1);
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ date: tomorrow, name: "Ada", value: 1000 }),
      );
      await withStripe(async (stripe) => {
        const response = await awaitTestRequest(
          qrBookPath(listing.slug, token),
        );
        expect(response.status).toBe(302);
        const intent = stripe.getCaptured()!;
        expect(intent.date).toBe(tomorrow);
        expect(intent.address).toBe("");
        expect(intent.email).toBe("");
        expect(intent.phone).toBe("");
        expect(intent.special_instructions).toBe("");
      });
    });

    test("skips straight to Stripe even when global terms are configured", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await settings.update.terms("# Test terms");
      const token = await bookToken(listing.slug);
      try {
        await withStripe(async (stripe) => {
          const response = await awaitTestRequest(
            qrBookPath(listing.slug, token),
          );
          expectStripeRedirect(response, stripe);
        });
      } finally {
        await settings.update.terms("");
      }
    });
  });
});
