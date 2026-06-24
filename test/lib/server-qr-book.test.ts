/**
 * Tests for the QR-book scan handler and its price-override plumbing.
 *
 * Covers three behaviours:
 *  - Error paths (missing/invalid/expired token, unknown listing)
 *  - Pre-fill rendering when the listing still needs user input
 *  - Skip-to-Stripe when all required data is carried in the signed token
 *  - Price override on POST for fixed-price listings
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { toMinorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { paymentsApi } from "#shared/payments.ts";
import {
  buildQrBookPayload,
  QR_TOKEN_MAX_AGE_S,
  signQrBookToken,
} from "#shared/qr-token.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  awaitTestRequest,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
  getAttendeesRaw,
  hasInputWithValue,
  mockProviderType,
  mockRequest,
  setupStripe,
  submitTicketForm,
} from "#test-utils";

const qrBookPath = (slug: string, token: string): string =>
  `/ticket/${slug}/qr-book?t=${encodeURIComponent(token)}`;

/** Stub Stripe as the active provider with a canned checkout URL */
const stubStripe = (checkoutUrl = "https://stripe.example/checkout") => {
  const providerStub = stub(paymentsApi, "getConfiguredProvider", () =>
    mockProviderType("stripe"),
  );
  const checkoutStub = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    () =>
      Promise.resolve({
        checkoutUrl,
        sessionId: "cs_test_123",
      }),
  );
  return {
    checkoutStub,
    restore: () => {
      providerStub.restore();
      checkoutStub.restore();
    },
  };
};

/** Sign a QR-book token for a slug (default payload: name "Ada", value 1000). */
const bookToken = (
  slug: string,
  payload: Parameters<typeof buildQrBookPayload>[0] = {
    name: "Ada",
    value: 1000,
  },
): Promise<string> => signQrBookToken(slug, buildQrBookPayload(payload));

/** Run `body` with Stripe stubbed as the active provider, restoring afterwards. */
const withStripe = async (
  body: (stripe: ReturnType<typeof stubStripe>) => Promise<void>,
): Promise<void> => {
  const stripe = stubStripe();
  try {
    await body(stripe);
  } finally {
    stripe.restore();
  }
};

/** Scan a listing's QR-book link (token built from `payload`) and return the response. */
const scanRequest = async (
  listing: { slug: string },
  payload?: Parameters<typeof bookToken>[1],
): Promise<Response> =>
  awaitTestRequest(
    qrBookPath(listing.slug, await bookToken(listing.slug, payload)),
  );

/** Scan a listing's QR-book link with Stripe stubbed; `body` gets response + stripe. */
const scanWithStripe = async (
  listing: { slug: string },
  body: (ctx: {
    response: Response;
    stripe: ReturnType<typeof stubStripe>;
  }) => Promise<void>,
  payload?: Parameters<typeof bookToken>[1],
): Promise<void> => {
  const token = await bookToken(listing.slug, payload);
  await withStripe(async (stripe) => {
    const response = await awaitTestRequest(qrBookPath(listing.slug, token));
    await body({ response, stripe });
  });
};

describeWithEnv("qr-book scan handler", { db: true }, () => {
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

    test("invalid signature renders the error page", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await awaitTestRequest(
        qrBookPath(listing.slug, "qr1.not-a-real-token.signature"),
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("expired or invalid");
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
      const time = new FakeTime(1_700_000_000_000);
      try {
        const token = await signQrBookToken(
          listing.slug,
          buildQrBookPayload({ name: "Ada", value: 500 }),
        );
        time.tick((QR_TOKEN_MAX_AGE_S + 30) * 1000);
        const response = await awaitTestRequest(
          qrBookPath(listing.slug, token),
        );
        expect(response.status).toBe(400);
      } finally {
        time.restore();
      }
    });

    test("deactivated listing is treated like unknown (404)", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 500,
      });
      await listingsTable.update(listing.id, { active: false });
      const response = await scanRequest(listing, { name: "Ada", value: 500 });
      expect(response.status).toBe(404);
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
    test("pre-fills the name input when the listing still needs other fields", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada Lovelace", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('value="Ada Lovelace"');
      expect(body).toContain('name="qr_token"');
    });

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
    test("redirects straight to Stripe when name + value are both set and no extra fields are required", async () => {
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await scanWithStripe(listing, async ({ response, stripe }) => {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("stripe.example");
        expect(stripe.checkoutStub.calls.length).toBe(1);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.name).toBe("Ada");
        expect(intent.items[0]!.unitPrice).toBe(1000);
        expect(intent.items[0]!.quantity).toBe(1);
      });
    });

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
        expect(stripe.checkoutStub.calls.length).toBe(0);
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
      await withStripe(async (stripe) => {
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
      const token = await bookToken(listing.slug);
      const providerStub = stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      );
      const checkoutStub = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve(null),
      );
      try {
        const response = await awaitTestRequest(
          qrBookPath(listing.slug, token),
        );
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain("expired or invalid");
      } finally {
        checkoutStub.restore();
        providerStub.restore();
      }
    });

    test("falls through to the form when the listing requires email", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await scanWithStripe(listing, async ({ response, stripe }) => {
        expect(response.status).toBe(200);
        expect(stripe.checkoutStub.calls.length).toBe(0);
      });
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
        expect(stripe.checkoutStub.calls.length).toBe(0);
      });
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
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.date).toBe(tomorrow);
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
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toContain("stripe.example");
          expect(stripe.checkoutStub.calls.length).toBe(1);
        });
      } finally {
        await settings.update.terms("");
      }
    });
  });

  describe("POST price override", () => {
    test("fixed-price listing: signed qr_token overrides unit_price for the booking", async () => {
      await setupStripe();
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const overridePrice = toMinorUnits(12.5);
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", value: overridePrice }),
      );
      await withStripe(async (stripe) => {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: token,
        });
        // Response is a 302 redirect to Stripe
        expect(response.status).toBe(302);
        expect(stripe.checkoutStub.calls.length).toBe(1);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(overridePrice);
      });
    });

    test("tampered qr_token is ignored; original unit_price is used", async () => {
      await setupStripe();
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await withStripe(async (stripe) => {
        const response = await submitTicketForm(listing.slug, {
          [`quantity_${listing.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: "qr1.forged.signature",
        });
        expect(response.status).toBe(302);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(500);
      });
    });

    test("can_pay_more listing: user's custom_price wins over the qr_token value", async () => {
      await setupStripe();
      const listing = await createTestListing({
        canPayMore: true,
        fields: "email",
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const token = await bookToken(listing.slug);
      await withStripe(async (stripe) => {
        const response = await submitTicketForm(listing.slug, {
          [`custom_price_${listing.id}`]: "50.00",
          [`quantity_${listing.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: token,
        });
        expect(response.status).toBe(302);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(5000);
      });
    });

    test("free booking path still works without a qr_token (no regression)", async () => {
      const listing = await createTestListing({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 0,
      });
      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "ada@example.com",
        name: "Ada",
      });
      expect(response.status).toBe(302);
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });
  });
});
