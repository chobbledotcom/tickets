import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { getStripeClient } from "#shared/stripe.ts";
import type { Listing } from "#shared/types.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

type StripeClient = NonNullable<Awaited<ReturnType<typeof getStripeClient>>>;

/**
 * Stores a Stripe secret key in the database and hands back the ready client.
 * Every Stripe test that needs a live client starts this way, so the "set the
 * key, fetch the client, make sure it exists" dance lives here once.
 */
export const stripeClient = async (
  key = "sk_test_mock",
): Promise<StripeClient> => {
  await settings.update.stripe.secretKey(key);
  // The key was just stored, so getStripeClient always resolves a client here.
  return (await getStripeClient())!;
};

/** A checkout line that mirrors a listing's id, name, slug, and price. */
export const lineFor = (listing: Listing, quantity = 1): CheckoutItem =>
  checkoutItem({
    listingId: listing.id,
    name: listing.name,
    quantity,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  });

/**
 * The shape of the checkout params Stripe's `sessions.create` receives — just
 * the pieces the tests inspect (line items and metadata).
 */
export type CreatedSessionParams = {
  line_items: {
    price_data: { product_data: { name: string }; unit_amount: number };
    quantity: number;
  }[];
  metadata: Record<string, string>;
};

/** A Stripe balance response, in test or live mode. */
export const balanceResult = (livemode: boolean) => ({
  available: [],
  livemode,
  object: "balance",
  pending: [],
});

/** A balance.retrieve behaviour that resolves to a healthy balance. */
export const okBalance = (livemode: boolean) => () =>
  Promise.resolve(balanceResult(livemode));

/** A webhookEndpoints.list behaviour that resolves to no endpoints. */
export const noWebhooks = () => Promise.resolve({ data: [] });

/**
 * Stubs both the balance check and the webhook-endpoints list for a connection
 * test, restoring both afterwards. Most testStripeConnection cases drive these
 * two calls together, so they are set up together here.
 */
export const withBalanceAndList = (
  client: StripeClient,
  balance: () => Promise<unknown>,
  list: () => Promise<unknown>,
  body: () => void | Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      balanceSpy: stub(client.balance, "retrieve", balance as never),
      listSpy: stub(client.webhookEndpoints, "list", list as never),
    }),
    body,
  );

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Builds the `t=…,v1=…` signature header Stripe sends with a webhook, signing
 * `${timestamp}.${payload}` with the secret exactly as the real sender does.
 * Defaults to the current time; pass an older timestamp to test tolerance.
 */
export const signedHeader = async (
  secret: string,
  payload: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> =>
  `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
