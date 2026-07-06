/**
 * Stripe SDK mocking helpers. Most Stripe tests enable Stripe with the mock
 * secret key, grab the client, and stub one of its calls (checkout create /
 * retrieve, a refund, a balance read, a webhook-endpoint list, a payment-intent
 * read) for the length of one test. These helpers package that repeated
 * scaffold so a test spells out only the response it wants and the assertion.
 */

import { afterEach, beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { getStripeClient, resetStripeClient } from "#shared/stripe.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { resetTestSlugCounter } from "#test-utils/internal.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** The live Stripe client type (getStripeClient's non-null result). */
export type StripeClient = NonNullable<
  Awaited<ReturnType<typeof getStripeClient>>
>;

/** The `describeWithEnv` env pin every Stripe suite shares — keeps the
 *  stripe-mock host/port stable for the tests that boot the real client. */
export const STRIPE_MOCK_ENV = {
  env: {
    STRIPE_MOCK_HOST: Deno.env.get("STRIPE_MOCK_HOST"),
    STRIPE_MOCK_PORT: Deno.env.get("STRIPE_MOCK_PORT"),
  },
};

/** Register the before/after hooks every Stripe suite uses: a fresh client and
 *  database before each test, and a clean-up after. Call inside a describe. */
export const resetStripeBetweenTests = (): void => {
  beforeEach(async () => {
    resetStripeClient();
    resetTestSlugCounter();
    await createTestDb();
  });
  afterEach(() => {
    resetStripeClient();
    resetDb();
  });
};

/** Enable Stripe with the mock secret key and hand back its ready client. */
export const enabledStripeClient = async (): Promise<StripeClient> => {
  await settings.update.stripe.secretKey("sk_test_mock");
  const client = await getStripeClient();
  if (!client) throw new Error("Expected client");
  return client;
};

/** A checkout.session shape the SDK returns from create/retrieve. */
export const checkoutSession = (
  id: string,
  url: string | null,
): { id: string; object: "checkout.session"; url: string | null } => ({
  id,
  object: "checkout.session",
  url,
});

/** Stub `client.checkout.sessions[method]` with `impl` for the length of
 *  `body`, then restore. `body` receives the stub for call assertions. */
export const withCheckoutSessionsStub = (
  client: StripeClient,
  method: "create" | "retrieve",
  impl: (...args: unknown[]) => unknown,
  body: (spy: ReturnType<typeof stub>) => void | Promise<void>,
): Promise<void> =>
  withMocks(() => stub(client.checkout.sessions, method, impl as never), body);

/** Stub the checkout `retrieve` call to resolve `session`, run `body`. */
export const withCheckoutRetrieve = (
  client: StripeClient,
  session: unknown,
  body: (spy: ReturnType<typeof stub>) => void | Promise<void>,
): Promise<void> =>
  withCheckoutSessionsStub(
    client,
    "retrieve",
    () => Promise.resolve(session as never),
    body,
  );

/** Stub the checkout `create` call to resolve `session`, run `body`. */
export const withCheckoutCreate = (
  client: StripeClient,
  session: unknown,
  body: (spy: ReturnType<typeof stub>) => void | Promise<void>,
): Promise<void> =>
  withCheckoutSessionsStub(
    client,
    "create",
    () => Promise.resolve(session as never),
    body,
  );

/** The `line_items` + `metadata` the checkout-create stub was called with. */
export const stripeCreateArgs = (
  createSpy: ReturnType<typeof stub>,
): {
  line_items: {
    price_data: { product_data: { name: string }; unit_amount: number };
    quantity: number;
  }[];
  metadata: Record<string, string>;
} =>
  createSpy.calls[0]!.args[0] as unknown as {
    line_items: {
      price_data: { product_data: { name: string }; unit_amount: number };
      quantity: number;
    }[];
    metadata: Record<string, string>;
  };

/** Stub the payment-intent `retrieve` call to resolve `intent`, run `body`. */
export const withPaymentIntent = (
  client: StripeClient,
  intent: unknown,
  body: () => void | Promise<void>,
): Promise<void> =>
  withMocks(
    () =>
      stub(client.paymentIntents, "retrieve", () =>
        Promise.resolve(intent as never),
      ),
    body,
  );

/** A resting Stripe balance in test or live mode. */
const balanceResult = (livemode: boolean) => ({
  available: [],
  livemode,
  object: "balance",
  pending: [],
});

/** Stub the two calls `testStripeConnection` makes — `balance.retrieve` and
 *  `webhookEndpoints.list` — for the length of `body`. By default the balance
 *  resolves (test mode) and the webhook list is empty; pass overrides to make
 *  either resolve differently or reject. */
export const withStripeStatus = (
  client: StripeClient,
  opts: {
    livemode?: boolean;
    balanceRejects?: unknown;
    webhooks?: unknown[];
    webhooksReject?: unknown;
  },
  body: () => void | Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      balanceSpy: stub(client.balance, "retrieve", () =>
        "balanceRejects" in opts
          ? Promise.reject(opts.balanceRejects)
          : (Promise.resolve(balanceResult(opts.livemode ?? false)) as never),
      ),
      listSpy: stub(client.webhookEndpoints, "list", (() =>
        "webhooksReject" in opts
          ? Promise.reject(opts.webhooksReject)
          : Promise.resolve({ data: opts.webhooks ?? [] })) as never),
    }),
    body,
  );
