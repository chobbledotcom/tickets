import type { StripeClient } from "#shared/stripe/client.ts";
import { createStripeClient } from "#shared/stripe/client.ts";

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
  maxNetworkRetries = 1,
): { capturedKey: () => string | null; client: StripeClient } => {
  let key: string | null = null;
  const client = createStripeClient(secretKey, {
    fetch: (_input, init = {}) => {
      key = new Headers(init.headers).get("idempotency-key");
      return Promise.resolve(
        Response.json({ id: "re_1", status: "succeeded" }),
      );
    },
    maxNetworkRetries,
  });
  return { capturedKey: () => key, client };
};
