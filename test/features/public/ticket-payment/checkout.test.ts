import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { runCheckoutFlow } from "#routes/public/ticket-payment.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

const debugText = (debug: { calls: readonly { args: unknown[] }[] }): string =>
  debug.calls.map((call) => call.args.join(" ")).join("\n");

const intentFor = (
  listing: Awaited<ReturnType<typeof createTestListing>>,
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [
    {
      listingId: listing.id,
      name: listing.name,
      quantity: 1,
      slug: listing.slug,
      unitPrice: 500,
    },
  ],
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
});

describeWithEnv("ticket payment checkout", { db: true }, () => {
  afterEach(() => {
    setSuppressDebugLogs(null);
  });

  test("reports the exact missing-provider error and checkout log", async () => {
    const configured = stub(paymentsApi, "getConfiguredProvider", () => null);
    const debug = spy(console, "debug");
    setSuppressDebugLogs(false);
    try {
      const response = await runCheckoutFlow(
        "test",
        new Request("https://tickets.test/ticket/test"),
        {} as CheckoutIntent,
        (message, status) => new Response(message, { status }),
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        "Payments are not configured. Please contact the administrator.",
      );
      expect(debugText(debug)).toContain("Starting test checkout");
      expect(debugText(debug)).toContain(
        "No payment provider configured for test checkout",
      );
    } finally {
      debug.restore();
      configured.restore();
    }
  });

  test("logs the provider, base URL, and created checkout URL", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 500 });
    const debug = spy(console, "debug");
    setSuppressDebugLogs(false);
    try {
      const response = await submitTicketForm(listing.slug, {
        email: "buyer@example.com",
        name: "Buyer",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toContain("checkout.stripe.com");
      const logs = debugText(debug);
      expect(logs).toContain("Using provider=stripe for ticket items=1");
      expect(logs).toContain(
        "Creating checkout session baseUrl=http://localhost",
      );
      expect(logs).toContain(
        `Checkout result for ticket items=1: url=${location}`,
      );
    } finally {
      debug.restore();
    }
  });

  test("returns the exact fallback when checkout creation has no result", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 500 });
    using _create = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve(null),
    );
    const response = await runCheckoutFlow(
      "fallback",
      new Request("https://tickets.test/ticket/test"),
      intentFor(listing),
      (message, status) => new Response(message, { status }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      "Failed to create payment session. Please try again.",
    );
  });

  test("returns a provider validation error as a bad request", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 500 });
    using _create = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve({ error: "Invalid test checkout" }),
    );
    const debug = spy(console, "debug");
    setSuppressDebugLogs(false);
    try {
      const response = await runCheckoutFlow(
        "validation",
        new Request("https://tickets.test/ticket/test"),
        intentFor(listing),
        (message, status) => new Response(message, { status }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid test checkout");
      expect(debugText(debug)).toContain(
        "Checkout validation error for validation: Invalid test checkout",
      );
    } finally {
      debug.restore();
    }
  });

  test("returns the exact conflict when availability changed", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 500 });
    using _availability = stub(attendeesApi, "checkBatchAvailability", () =>
      Promise.resolve(false),
    );
    const response = await runCheckoutFlow(
      "sold out",
      new Request("https://tickets.test/ticket/test"),
      intentFor(listing),
      (message, status) => new Response(message, { status }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(
      "Sorry, some tickets are no longer available",
    );
  });
});
