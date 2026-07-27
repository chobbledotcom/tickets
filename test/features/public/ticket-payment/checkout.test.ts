import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import {
  checkAvailability,
  runCheckoutFlow,
} from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { settings } from "#shared/db/settings.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  type CheckoutIntent,
  type CheckoutSessionResult,
  paymentsApi,
} from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { providerCheckoutResult } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

// A checkout always buys something, so the intent carries one line.
const intent: CheckoutIntent = {
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [
    {
      listingId: 7,
      name: "Test Listing",
      quantity: 1,
      slug: "test-listing",
      unitPrice: 1000,
    },
  ],
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

const request = new Request("https://tickets.example/ticket/test");
type CheckoutFailure = { message: string; status: number };

const captureCheckout = async (
  run: (
    onError: (message: string, status: number) => Response,
  ) => Promise<Response>,
): Promise<{ failure: CheckoutFailure | undefined; messages: unknown[] }> => {
  setSuppressDebugLogs(false);
  using debug = spy(console, "debug");
  let failure: CheckoutFailure | undefined;
  await run((message, status) => {
    failure = { message, status };
    return new Response("error");
  });
  return {
    failure,
    messages: debug.calls
      .map((call) => call.args[0])
      .filter((message) => String(message).startsWith("[Payment]")),
  };
};

const captureProviderCheckout = async (result: CheckoutSessionResult) => {
  settings.setForTest({ stripe_secret_key: "sk_test_checkout" });
  using _configured = stub(
    paymentsApi,
    "getConfiguredProvider",
    () => "stripe" as const,
  );
  using _checkout = stub(stripePaymentProvider, "createCheckout", () =>
    Promise.resolve(providerCheckoutResult(result)),
  );
  return await captureCheckout((onError) =>
    runCheckoutFlow("test", request, intent, onError),
  );
};

describeWithEnv("runCheckoutFlow", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverrides();
    setSuppressDebugLogs(null);
  });

  test("reports the missing-provider status and logs the failed start", async () => {
    using configured = stub(paymentsApi, "getConfiguredProvider", () => null);
    const result = await captureCheckout((onError) =>
      runCheckoutFlow("test", request, intent, onError),
    );

    expect(configured.calls).toHaveLength(1);
    expect(result.failure).toEqual({
      message: "Payments are not configured. Please contact the administrator.",
      status: 500,
    });
    expect(result.messages).toEqual([
      "[Payment] Starting test checkout",
      "[Payment] No payment provider configured in settings",
      "[Payment] No payment provider configured for test checkout",
    ]);
  });

  test("logs a successful provider checkout", async () => {
    const result = await captureProviderCheckout({
      checkoutUrl: "https://pay.example/session",
      sessionId: "session",
    });

    expect(result.failure).toBeUndefined();
    expect(result.messages).toEqual([
      "[Payment] Starting test checkout",
      "[Payment] Creating checkout session baseUrl=https://tickets.example",
      "[Payment] Resolving payment provider: stripe",
      "[Payment] Checkout result for test: url=https://pay.example/session",
    ]);
  });

  test("reports and logs a provider validation error", async () => {
    const result = await captureProviderCheckout({ error: "Invalid order" });

    expect(result.failure).toEqual({ message: "Invalid order", status: 400 });
    expect(result.messages).toEqual([
      "[Payment] Starting test checkout",
      "[Payment] Creating checkout session baseUrl=https://tickets.example",
      "[Payment] Resolving payment provider: stripe",
      "[Payment] Checkout validation error for test: Invalid order",
    ]);
  });

  test("reports and logs an empty provider result", async () => {
    const result = await captureProviderCheckout(null);

    expect(result.failure).toEqual({
      message: "Failed to create payment session. Please try again.",
      status: 500,
    });
    expect(result.messages).toEqual([
      "[Payment] Starting test checkout",
      "[Payment] Creating checkout session baseUrl=https://tickets.example",
      "[Payment] Resolving payment provider: stripe",
      "[Payment] Checkout result for test: null",
      "[Payment] Checkout redirect failed for test: no session URL",
    ]);
  });
});

test("checkAvailability uses a one-day dateless booking by default", async () => {
  using check = stub(attendeesApi, "checkBatchAvailability", () =>
    Promise.resolve(true),
  );
  const listing = testListingWithCount({ id: 7 });

  expect(
    await checkAvailability(
      [buildTicketListing(listing, false, undefined)],
      new Map([[listing.id, 2]]),
    ),
  ).toBe(true);
  expect(check.calls[0]!.args).toEqual([
    [{ date: null, durationDays: 1, listingId: 7, quantity: 2 }],
    undefined,
  ]);
});
