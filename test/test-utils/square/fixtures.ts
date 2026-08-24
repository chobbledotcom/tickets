import { expect } from "@std/expect";
import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import type { RefundRequest } from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
} from "#payment/refund-provider-authorization.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createMockClient } from "#test-utils/square/harness.ts";

type MockImpls = Parameters<typeof createMockClient>[0];
type SquareMock = ReturnType<typeof createMockClient>;

/** Give a Square request the durable permit its provider boundary requires. */
export const squareRefundRequest = (
  request: RefundRequest,
  idempotencyKey = `test-refund:${request.paymentReference}:1`,
): AuthorizedRefundRequest<"square"> =>
  authorizeDurableRefundSend(request, {
    capability: "keyed",
    generation: 1,
    idempotencyKey,
    identityIndex: `test-refund-index:${request.paymentReference}:1`,
    provider: "square",
  });

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

/**
 * Runs the body against the real Square client, with one REST answer stubbed
 * in. Use it to prove what a boundary makes of an answer Square really sends;
 * `withSquareClient` stands in for the client, so it never reaches the parse.
 */
export const withSquareAnswer = async <Result>(
  body: unknown,
  run: () => Promise<Result>,
): Promise<Result> => {
  await configureSquare();
  using _fetch = stubFetch(new Response(JSON.stringify(body)));
  return await run();
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
 * A checkout behaviour that returns a created payment link with the given
 * order id and address — the happy path for `checkout.paymentLinks.create`.
 */
export const linkResult = (orderId: string, url: string): MockImpls => ({
  checkoutCreate: () => Promise.resolve({ orderId, url }),
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
  _origin: "example.com",
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
  price_proof: "0.test-signature",
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
