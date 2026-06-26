/**
 * Stripe API stub helpers — mirror the `builder-mocks.ts` pattern for Stripe
 * integration tests. Instead of spelling out
 *
 *   stub(stripeApi, "retrieveCheckoutSession", () =>
 *     Promise.resolve({ id: "cs_test", metadata: {…}, … } as unknown as Awaited<
 *       ReturnType<typeof stripeApi.retrieveCheckoutSession>
 *     >))
 *
 * in 20+ tests, use `stubRetrieveSession(fields)` / `stubRefundPayment(result)`
 * or the bundle `withStripeMocks(body, opts)`.
 */

import { type Stub, stub } from "@std/testing/mock";
import { type StripeCheckoutFields, stripeApi } from "#shared/stripe.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** The `as unknown as Awaited<ReturnType<...>>` cast every inline stub
 *  spelled out. Now callers just pass the partial fields. */
export const stubRetrieveSession = (fields: StripeCheckoutFields): Stub =>
  stub(stripeApi, "retrieveCheckoutSession", () => Promise.resolve(fields));

/** Stub `stripeApi.refundPayment` to resolve `result` (default: success). */
export const stubRefundPayment = (
  result: { id: string } | null = { id: "re_test" },
): Stub =>
  stub(stripeApi, "refundPayment", () => Promise.resolve(result as never));

interface StripeMockOptions {
  /** The checkout session `retrieveCheckoutSession` returns. */
  session: StripeCheckoutFields;
  /** The refund result `refundPayment` returns (default: `{ id: "re_test" }`). */
  refundResult?: { id: string } | null;
}

/** The mock objects `withStripeMocks` exposes to its body. */
export type StripeMocks = {
  retrieveStub: Stub;
  refundStub: Stub;
};

/**
 * Install both `retrieveCheckoutSession` and `refundPayment` stubs for the
 * duration of `body`, then restore — mirroring `withBuildSiteMocks`. Pass
 * `opts.session` for the checkout session fields; `opts.refundResult` defaults
 * to a successful refund.
 */
export const withStripeMocks = (
  opts: StripeMockOptions,
  body: (mocks: StripeMocks) => void | Promise<void>,
  cleanup?: () => void,
): Promise<void> =>
  withMocks(
    () => ({
      refundStub: stubRefundPayment(opts.refundResult),
      retrieveStub: stubRetrieveSession(opts.session),
    }),
    body,
    cleanup,
  );
