import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";

/**
 * The refund path is where the live callbacks reject a blank provider resource
 * id — consistently, whatever the provider, because every refund goes through
 * `tryRefund`. A blank or whitespace-only id names no charge to refund, so the
 * refund is refused before any provider call. (A captured charge is still kept
 * and surfaced — see storeRefundedBooking — only the refund is refused.)
 *
 * A provider is configured and its refund methods spied on, so the assertions
 * prove the guard fires before any provider work rather than merely returning
 * false because no provider was resolvable.
 */
describe("tryRefund resource id", () => {
  const withStripeProvider = async (
    run: () => Promise<void>,
  ): Promise<void> => {
    const original = paymentsApi.getConfiguredProvider;
    paymentsApi.getConfiguredProvider = () => "stripe";
    const refundSpy = spy(stripeApi, "refundPayment");
    const intentSpy = spy(stripeApi, "retrievePaymentIntent");
    try {
      await run();
      expect(refundSpy.calls.length).toBe(0);
      expect(intentSpy.calls.length).toBe(0);
    } finally {
      refundSpy.restore();
      intentSpy.restore();
      paymentsApi.getConfiguredProvider = original;
    }
  };

  it("refuses an empty provider resource id before any provider call", () =>
    withStripeProvider(async () => {
      expect(await tryRefund("")).toBe(false);
    }));

  it("refuses a whitespace-only provider resource id before any provider call", () =>
    withStripeProvider(async () => {
      expect(await tryRefund("   ")).toBe(false);
      expect(await tryRefund("\t\n")).toBe(false);
    }));
});
