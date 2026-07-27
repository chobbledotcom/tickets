import type { StripeClient } from "#shared/stripe/client.ts";
import { createStripeClient } from "#shared/stripe/client.ts";
import { stripeRefund } from "./fixtures.ts";

/**
 * Build a Stripe client whose fetch records the Idempotency-Key header sent
 * on each request and answers a succeeded refund. Shared by the tests that
 * assert which idempotency key reaches the wire for a refund POST.
 *
 * `capturedKey` reads the header value from the most recent request, so a test
 * can assert the exact key (or its absence) after calling `refunds.create`.
 */
export const refundHeaderProbe = (
  secretKey = "sk_test_secret",
): { capturedKey: () => string | null; client: StripeClient } => {
  let key: string | null = null;
  // One retry allowed so a retry-generated key WOULD exist by default; the
  // caller's key must take precedence over it, which is what the shared tests
  // assert. With zero retries the override has nothing to override.
  const client = createStripeClient(secretKey, {
    fetch: (_input, init = {}) => {
      key = new Headers(init.headers).get("idempotency-key");
      return Promise.resolve(Response.json(stripeRefund({ id: "re_1" })));
    },
    maxNetworkRetries: 1,
  });
  return { capturedKey: () => key, client };
};
