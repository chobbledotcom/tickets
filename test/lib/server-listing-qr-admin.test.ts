/**
 * Tests for the admin "generate booking QR code" page.
 *
 * Exercises the end-to-end flow: form rendering, validation, token signing,
 * and the embedded QR SVG. Auth, CSRF, and role checks are shared with other
 * admin routes and tested there.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  adminFormPost,
  adminGet,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

/** Extract the ?t= token from a generated QR booking link */
const extractToken = (html: string): string | null => {
  const match = html.match(/\/qr-book\?t=([^"\s&]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
};

describeWithEnv("admin listing-qr route", { db: true }, () => {
  describe("GET /admin/listing/:id/qr", () => {
    testRequiresAuth("/admin/listing/1/qr", {
      setup: async () => {
        await createTestListing({ maxAttendees: 10 });
      },
    });

    test("returns 404 when the listing does not exist", async () => {
      const response = await adminGet("/admin/listing/99999/qr");
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("renders the form with quantity defaulted to 1", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const response = await adminGet(`/admin/listing/${listing.id}/qr`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('name="customer_name"');
      expect(body).toContain('name="value"');
      expect(body).toContain('name="quantity"');
      expect(body).toContain('value="1"');
    });

    test("shows green indicator for listing with no extra fields, red when extra fields required", async () => {
      const noFields = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const withFields = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const r1 = await adminGet(`/admin/listing/${noFields.id}/qr`);
      const r2 = await adminGet(`/admin/listing/${withFields.id}/qr`);
      expect(await r1.text()).toContain('class="success-text"');
      expect(await r2.text()).toContain('class="danger-text"');
    });

    test("shows a date selector for daily listings", async () => {
      const listing = await createDailyTestListing({ unitPrice: 500 });
      const response = await adminGet(`/admin/listing/${listing.id}/qr`);
      const body = await response.text();
      expect(body).toContain('name="date"');
    });

    test("offers single-day dates for a customisable daily listing", async () => {
      const listing = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      const response = await adminGet(`/admin/listing/${listing.id}/qr`);
      const body = await response.text();
      expect(body).toContain('name="date"');
      // A date one day before the window edge supports a single day even though
      // it can't fit the 2-day maximum — single-day availability still offers it.
      expect(body).toContain(addDays(todayInTz("UTC"), 60));
    });

    test("offers only child-servable dates for a daily parent (Fix 2)", async () => {
      // The parent is bookable every weekday, but its only (daily) child is
      // bookable only on Mondays. The QR form's date choices must be constrained
      // to dates a required child can serve, so an admin can't mint a QR for a
      // date the (child-constrained) scanned booking form would reject (Fix 2).
      const { setChildIds } = await import("#shared/db/listing-parents.ts");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parent = await createDailyTestListing({ unitPrice: 500 });
      const child = await createDailyTestListing({
        bookableDays: ["Monday"],
        unitPrice: 500,
      });
      await setChildIds(parent.id, [child.id]);

      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        holidays,
      );
      const childDates = new Set(
        getBookableStartDates((await getListingWithCount(child.id))!, holidays),
      );
      const servable = parentDates.find((d) => childDates.has(d))!;
      const unservable = parentDates.find((d) => !childDates.has(d))!;

      const response = await adminGet(`/admin/listing/${parent.id}/qr`);
      const body = await response.text();
      expect(body).toContain(`value="${servable}"`);
      expect(body).not.toContain(`value="${unservable}"`);
    });

    test("omits the date selector for standard listings", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const response = await adminGet(`/admin/listing/${listing.id}/qr`);
      const body = await response.text();
      expect(body).not.toContain('name="date"');
    });
  });

  describe("POST /admin/listing/:id/qr", () => {
    test("rejects invalid CSRF for an authenticated session", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const cookie = await testCookie();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/qr`,
          { csrf_token: "invalid", quantity: "1" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      response.body?.cancel();
    });

    test("renders a validation error when quantity exceeds max", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 2,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          quantity: "5",
        },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Quantity cannot exceed 2");
      expect(body).not.toContain("/qr-book?t=");
    });

    test("renders a validation error when quantity is not a strict integer", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        { quantity: "2x" },
      );
      const body = await response.text();
      expect(body).toContain("Quantity must be at least 1");
    });

    test("renders a validation error when daily listing is missing a date", async () => {
      const listing = await createDailyTestListing({ unitPrice: 500 });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          customer_name: "Ada",
          quantity: "1",
          value: "5.00",
        },
      );
      const body = await response.text();
      expect(body).toContain("Date is required");
    });

    test("returns 404 when the listing does not exist", async () => {
      const { response } = await adminFormPost("/admin/listing/99999/qr", {
        quantity: "1",
      });
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("accepts a valid daily date and signs a token", async () => {
      // A daily listing's submitted date must be one of its bookable dates; a
      // valid one passes and a token is generated (covers the date-allowed path).
      const listing = await createDailyTestListing({ unitPrice: 500 });
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const date = getBookableStartDates(
        (await getListingWithCount(listing.id))!,
        await getActiveHolidays(),
      )[0]!;
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        { customer_name: "Ada", date, quantity: "1", value: "5.00" },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("/qr-book?t=");
    });

    test("rejects a daily date no required child can serve (Fix 2)", async () => {
      // Posting a raw date the dropdown wouldn't offer (a date no required child
      // can serve) is rejected by the validator, not just hidden from the form.
      const { setChildIds } = await import("#shared/db/listing-parents.ts");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parent = await createDailyTestListing({ unitPrice: 500 });
      const child = await createDailyTestListing({
        bookableDays: ["Monday"],
        unitPrice: 500,
      });
      await setChildIds(parent.id, [child.id]);
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(
        (await getListingWithCount(parent.id))!,
        holidays,
      );
      const childDates = new Set(
        getBookableStartDates((await getListingWithCount(child.id))!, holidays),
      );
      const unservable = parentDates.find((d) => !childDates.has(d))!;
      const { response } = await adminFormPost(
        `/admin/listing/${parent.id}/qr`,
        { customer_name: "Ada", date: unservable, quantity: "1" },
      );
      const body = await response.text();
      expect(body).toContain("Please select a valid date");
      expect(body).not.toContain("/qr-book?t=");
    });

    test("renders a validation error for pay-more price below minimum", async () => {
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          quantity: "1",
          value: "1.00",
        },
      );
      const body = await response.text();
      expect(body).toContain("at least the minimum");
    });

    test("accepts any price for fixed-price listings as a one-off override", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          customer_name: "Ada",
          quantity: "1",
          // Way above the listing's unit_price; allowed for the override
          value: "200.00",
        },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("/qr-book?t=");
      expect(body).toContain("<svg");
    });

    test("signed token embeds submitted values and matches the listing slug", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          customer_name: "Ada Lovelace",
          quantity: "3",
          value: "12.50",
        },
      );
      const body = await response.text();
      const token = extractToken(body);
      expect(token).not.toBeNull();
      const payload = await verifyQrBookToken(listing.slug, token!);
      expect(payload).not.toBeNull();
      expect(payload!.n).toBe("Ada Lovelace");
      expect(payload!.v).toBe(1250);
      expect(payload!.q).toBe(3);
    });

    test("generates a token when customer_name is omitted, defaulting quantity to 1", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/qr`,
        {
          // No customer_name, no quantity, no value
        },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const token = extractToken(body);
      expect(token).not.toBeNull();
      const payload = await verifyQrBookToken(listing.slug, token!);
      expect(payload!.n).toBe("");
      expect(payload!.q).toBe(1);
      expect(payload!.v).toBe(-1);
    });

    test("tokens are scoped to their listing slug", async () => {
      const a = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
      const b = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/listing/${a.id}/qr`, {
        customer_name: "Ada",
        quantity: "1",
        value: "5.00",
      });
      const body = await response.text();
      const token = extractToken(body)!;
      expect(await verifyQrBookToken(b.slug, token)).toBeNull();
    });
  });

  describe("GET /admin/listing/:id/qr.json (client-side refresh)", () => {
    testRequiresAuth("/admin/listing/1/qr.json?quantity=1", {
      setup: async () => {
        await createTestListing({ maxAttendees: 10 });
      },
    });

    test("returns 404 when the listing does not exist", async () => {
      const response = await adminGet(
        "/admin/listing/99999/qr.json?quantity=1",
      );
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("returns JSON with a fresh token matching submitted values", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const response = await adminGet(
        `/admin/listing/${listing.id}/qr.json?customer_name=Ada&value=7.50&quantity=2`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const body = (await response.json()) as {
        ok: boolean;
        url: string;
        svg: string;
      };
      expect(body.ok).toBe(true);
      expect(body.svg).toContain("<svg");
      const match = body.url.match(/\/qr-book\?t=([^&]+)/);
      expect(match).not.toBeNull();
      const token = decodeURIComponent(match![1]!);
      const payload = await verifyQrBookToken(listing.slug, token);
      expect(payload!.n).toBe("Ada");
      expect(payload!.v).toBe(750);
      expect(payload!.q).toBe(2);
    });

    test("returns 400 JSON on validation failure", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 2,
        unitPrice: 500,
      });
      const response = await adminGet(
        `/admin/listing/${listing.id}/qr.json?quantity=99`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        ok: boolean;
        error?: string;
      };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Quantity cannot exceed");
    });

    test("signs a different token each minute (fresh expiry)", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const first = await adminGet(
        `/admin/listing/${listing.id}/qr.json?customer_name=Ada&value=5.00&quantity=1`,
      );
      await new Promise((r) => setTimeout(r, 1100));
      const second = await adminGet(
        `/admin/listing/${listing.id}/qr.json?customer_name=Ada&value=5.00&quantity=1`,
      );
      const a = (await first.json()) as { url: string };
      const b = (await second.json()) as { url: string };
      expect(a.url).not.toBe(b.url);
    });
  });
});
