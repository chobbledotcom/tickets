/**
 * Tests for the QR-book scan handler and its price-override plumbing.
 *
 * Covers three behaviours:
 *  - Error paths (missing/invalid/expired token, unknown event)
 *  - Pre-fill rendering when the event still needs user input
 *  - Skip-to-Stripe when all required data is carried in the signed token
 *  - Price override on POST for fixed-price events
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { toMinorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import { eventsTable } from "#shared/db/events.ts";
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
  createDailyTestEvent,
  createTestEvent,
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

describeWithEnv("qr-book scan handler", { db: true }, () => {
  describe("error paths", () => {
    test("missing ?t= token renders the error page", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}/qr-book`),
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("expired or invalid");
      expect(body).toContain(`/ticket/${event.slug}`);
    });

    test("invalid signature renders the error page", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await awaitTestRequest(
        qrBookPath(event.slug, "qr1.not-a-real-token.signature"),
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("expired or invalid");
    });

    test("unknown event slug renders the error page", async () => {
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
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const time = new FakeTime(1_700_000_000_000);
      try {
        const token = await signQrBookToken(
          event.slug,
          buildQrBookPayload({ name: "Ada", value: 500 }),
        );
        time.tick((QR_TOKEN_MAX_AGE_S + 30) * 1000);
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(400);
      } finally {
        time.restore();
      }
    });

    test("deactivated event is treated like unknown (404)", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      await eventsTable.update(event.id, { active: false });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      expect(response.status).toBe(404);
    });

    test("daily event with an un-bookable date is rejected", async () => {
      const event = await createDailyTestEvent({ unitPrice: 500 });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ date: "1999-01-01", name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      expect(response.status).toBe(400);
    });

    test("daily event with no date in the token is rejected", async () => {
      const event = await createDailyTestEvent({ unitPrice: 500 });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      expect(response.status).toBe(400);
    });
  });

  describe("pre-fill rendering", () => {
    test("pre-fills the name input when the event still needs other fields", async () => {
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada Lovelace", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('value="Ada Lovelace"');
      expect(body).toContain('name="qr_token"');
    });

    test("pre-fills custom_price input for can_pay_more events", async () => {
      const event = await createTestEvent({
        canPayMore: true,
        fields: "email",
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 2500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      const body = await response.text();
      expect(hasInputWithValue(body, `custom_price_${event.id}`, "25.00")).toBe(
        true,
      );
    });

    test("pre-fills quantity for the event row", async () => {
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", quantity: 3, value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      const body = await response.text();
      expect(body).toMatch(/<option value="3"\s+selected>/);
    });

    test("pre-fills the daily date selector", async () => {
      const event = await createDailyTestEvent({
        fields: "email",
        unitPrice: 500,
      });
      const tomorrow = addDays(todayInTz(settings.timezone), 1);
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ date: tomorrow, name: "Ada", value: 500 }),
      );
      const response = await awaitTestRequest(qrBookPath(event.slug, token));
      const body = await response.text();
      expect(body).toMatch(new RegExp(`value="${tomorrow}"\\s+selected`));
    });
  });

  describe("skip-to-Stripe", () => {
    test("redirects straight to Stripe when name + value are both set and no extra fields are required", async () => {
      const event = await createTestEvent({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("stripe.example");
        expect(stripe.checkoutStub.calls.length).toBe(1);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.name).toBe("Ada");
        expect(intent.items[0]!.unitPrice).toBe(1000);
        expect(intent.items[0]!.quantity).toBe(1);
      } finally {
        stripe.restore();
      }
    });

    test("renders the error page when the provider cannot create a session", async () => {
      const event = await createTestEvent({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const providerStub = stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      );
      const checkoutStub = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve(null),
      );
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain("expired or invalid");
      } finally {
        checkoutStub.restore();
        providerStub.restore();
      }
    });

    test("falls through to the form when the event requires email", async () => {
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(200);
        expect(stripe.checkoutStub.calls.length).toBe(0);
      } finally {
        stripe.restore();
      }
    });

    test("falls through when name is missing even though value is set", async () => {
      const event = await createTestEvent({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(200);
        expect(stripe.checkoutStub.calls.length).toBe(0);
      } finally {
        stripe.restore();
      }
    });

    test("daily event with a bookable date skips straight to Stripe with the date set", async () => {
      const event = await createDailyTestEvent({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const tomorrow = addDays(todayInTz(settings.timezone), 1);
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ date: tomorrow, name: "Ada", value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(302);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.date).toBe(tomorrow);
      } finally {
        stripe.restore();
      }
    });

    test("skips straight to Stripe even when global terms are configured", async () => {
      const event = await createTestEvent({
        fields: "",
        maxAttendees: 10,
        unitPrice: 500,
      });
      await settings.update.terms("# Test terms");
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await awaitTestRequest(qrBookPath(event.slug, token));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("stripe.example");
        expect(stripe.checkoutStub.calls.length).toBe(1);
      } finally {
        await settings.update.terms("");
        stripe.restore();
      }
    });
  });

  describe("POST price override", () => {
    test("fixed-price event: signed qr_token overrides unit_price for the booking", async () => {
      await setupStripe();
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const overridePrice = toMinorUnits(12.5);
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: overridePrice }),
      );
      const stripe = stubStripe();
      try {
        const response = await submitTicketForm(event.slug, {
          [`quantity_${event.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: token,
        });
        // Response is a 302 redirect to Stripe
        expect(response.status).toBe(302);
        expect(stripe.checkoutStub.calls.length).toBe(1);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(overridePrice);
      } finally {
        stripe.restore();
      }
    });

    test("tampered qr_token is ignored; original unit_price is used", async () => {
      await setupStripe();
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 500,
      });
      const stripe = stubStripe();
      try {
        const response = await submitTicketForm(event.slug, {
          [`quantity_${event.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: "qr1.forged.signature",
        });
        expect(response.status).toBe(302);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(500);
      } finally {
        stripe.restore();
      }
    });

    test("can_pay_more event: user's custom_price wins over the qr_token value", async () => {
      await setupStripe();
      const event = await createTestEvent({
        canPayMore: true,
        fields: "email",
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const token = await signQrBookToken(
        event.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const stripe = stubStripe();
      try {
        const response = await submitTicketForm(event.slug, {
          [`custom_price_${event.id}`]: "50.00",
          [`quantity_${event.id}`]: "1",
          email: "ada@example.com",
          name: "Ada",
          qr_token: token,
        });
        expect(response.status).toBe(302);
        const intent = stripe.checkoutStub.calls[0]!.args[0];
        expect(intent.items[0]!.unitPrice).toBe(5000);
      } finally {
        stripe.restore();
      }
    });

    test("free booking path still works without a qr_token (no regression)", async () => {
      const event = await createTestEvent({
        fields: "email",
        maxAttendees: 10,
        unitPrice: 0,
      });
      const response = await submitTicketForm(event.slug, {
        [`quantity_${event.id}`]: "1",
        email: "ada@example.com",
        name: "Ada",
      });
      expect(response.status).toBe(302);
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });
  });
});
