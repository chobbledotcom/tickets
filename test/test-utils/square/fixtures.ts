import { expect } from "@std/expect";
import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { createMockClient } from "#test/test-utils/square/harness.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";

type MockImpls = Parameters<typeof createMockClient>[0];
type SquareMock = ReturnType<typeof createMockClient>;

/**
 * Runs the test body with a fake Square SDK client standing in for the real
 * one: it builds the mock from the given method behaviours, points
 * `getSquareClient` at it, and restores the original afterwards. The mock
 * (with its spyable methods) is handed to the body.
 */
export const withSquareClient = async <Result>(
  impls: MockImpls,
  body: (mock: SquareMock) => Result | Promise<Result>,
): Promise<Result> => {
  const mock = createMockClient(impls);
  const client = stub(squareApi, "getSquareClient", () =>
    Promise.resolve(mock.client),
  );
  try {
    return await body(mock);
  } finally {
    client.restore();
  }
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
  checkoutCreate: () => Promise.resolve({ paymentLink: { orderId, url } }),
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

/** A Square Money value in the given minor units (defaults to GBP). */
export const squareMoney = (
  amount: number,
  currency = "GBP",
): { amount: bigint; currency: string } => ({
  amount: BigInt(amount),
  currency,
});

/** The canonical order metadata for a single-ticket Square checkout. */
export const SQUARE_ORDER_META = {
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

/**
 * Give a Square provider suite a database, a site domain, and a readable debug
 * log. Call it inside a describe block — it registers that block's hooks, and
 * hands back the spy the "why did this skip?" assertions read.
 */
export const setupSquareProviderSuite = (): (() => Spy) => {
  let debug: Spy;
  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
    setSuppressDebugLogs(false);
    debug = spy(console, "debug");
  });
  afterEach(() => {
    debug.restore();
    setSuppressDebugLogs(null);
    resetDb();
  });
  return () => debug;
};
