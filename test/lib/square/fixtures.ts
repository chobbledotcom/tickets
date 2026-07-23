import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutIntent, WebhookEvent } from "#shared/payments.ts";
import { squareApi } from "#shared/square.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { createMockClient } from "./harness.ts";

type MockImpls = Parameters<typeof createMockClient>[0];
type SquareMock = ReturnType<typeof createMockClient>;

/**
 * Runs the test body with a fake Square SDK client standing in for the real
 * one: it builds the mock from the given method behaviours, points
 * `getSquareClient` at it, and restores the original afterwards. The mock
 * (with its spyable methods) is handed to the body.
 */
export const withSquareClient = (
  impls: MockImpls,
  body: (mock: SquareMock) => void | Promise<void>,
): Promise<void> => {
  const mock = createMockClient(impls);
  return withMocks(
    () =>
      stub(squareApi, "getSquareClient", () => Promise.resolve(mock.client)),
    () => body(mock),
  );
};

/** Asserts that creating a payment link for this intent yields no link. */
export const expectNoLink = async (
  intent: CheckoutIntent,
  redirectUrl = "http://localhost",
): Promise<void> => {
  const result = await squareApi.createPaymentLink(intent, redirectUrl);
  expect(result).toBeNull();
};

/** A locations.list response holding a single active location. */
export const oneLocation = (id: string, name: string) => ({
  locations: [{ id, name, status: "ACTIVE" }],
});

/**
 * A checkout SDK behaviour that returns a payment link with the given order
 * id and url — the happy-path response for `checkout.paymentLinks.create`.
 */
export const linkResult = (orderId: string, url: string): MockImpls => ({
  checkoutCreate: () =>
    Promise.resolve({ paymentLink: { id: `link_${orderId}`, orderId, url } }),
});

/**
 * Stores Square credentials in the database. The access token defaults to a
 * test value; pass sandbox / location / webhook key only when the test needs
 * them so each caller says exactly what it relies on.
 */
export const configureSquare = async (
  opts: {
    accessToken?: string;
    sandbox?: boolean;
    locationId?: string;
    webhookSignatureKey?: string;
  } = {},
): Promise<void> => {
  await settings.update.square.accessToken(
    opts.accessToken ?? "EAAAl_test_123",
  );
  if (opts.sandbox !== undefined) {
    await settings.update.square.sandbox(opts.sandbox);
  }
  if (opts.locationId !== undefined) {
    await settings.update.square.locationId(opts.locationId);
  }
  if (opts.webhookSignatureKey !== undefined) {
    await settings.update.square.webhookSignatureKey(opts.webhookSignatureKey);
  }
};

/** Configure Square and make it the active checkout provider. */
export const activateSquare = async (): Promise<void> => {
  await configureSquare();
  await settings.update.paymentProvider("square");
};

/** Stub one completed Square payment whose full amount was later refunded. */
export const refundedSquareSessionMocks = (
  orderId: string,
  paymentId: string,
  metadata: Record<string, string>,
  withTender = true,
): { order: Stub; payment: Stub } => ({
  order: stub(squareApi, "retrieveOrder", () =>
    Promise.resolve({
      id: orderId,
      metadata,
      state: "COMPLETED",
      ...(withTender && { tenders: [{ paymentId }] }),
      totalMoney: { amount: BigInt(1000), currency: "USD" },
    }),
  ),
  payment: stub(squareApi, "retrievePayment", () =>
    Promise.resolve({
      amountMoney: { amount: BigInt(1000), currency: "USD" },
      id: paymentId,
      orderId,
      refundedMoney: { amount: BigInt(1000), currency: "USD" },
      status: "COMPLETED",
    }),
  ),
});

/** A completed Square payment event for one order. */
export const squarePaymentEvent = (
  eventId: string,
  orderId: string,
  paymentId: string,
): WebhookEvent => ({
  data: {
    object: {
      payment: {
        id: paymentId,
        order_id: orderId,
        status: "COMPLETED",
      },
    },
  },
  id: eventId,
  type: "payment.updated",
});
