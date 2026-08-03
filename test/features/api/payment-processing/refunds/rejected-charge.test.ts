import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import {
  refundRejectedCharge,
  refundRejectedSession,
  tryRefund,
} from "#routes/api/payment-processing/refunds.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { signedMeta, webhookMeta } from "#test-utils/factories.ts";

setupTestEncryptionKey();

/** What Stripe answers a refund it accepted with. */
const succeededRefund = {
  id: "re_settled",
  status: "succeeded",
} as unknown as Awaited<ReturnType<typeof stripeApi.refundPayment>>;

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
  /** Run `body` with Stripe as the configured provider. */
  const withStripeConfigured = async (
    body: () => Promise<void>,
  ): Promise<void> => {
    const original = paymentsApi.getConfiguredProvider;
    paymentsApi.getConfiguredProvider = () => "stripe";
    try {
      await body();
    } finally {
      paymentsApi.getConfiguredProvider = original;
    }
  };

  /** Run `body` and prove it never reached Stripe — spies keep the real
   *  methods, so a call would leave for the provider and be counted here. */
  const withStripeProvider = (run: () => Promise<void>): Promise<void> =>
    withStripeConfigured(async () => {
      const refundSpy = spy(stripeApi, "refundPayment");
      const intentSpy = spy(stripeApi, "retrievePaymentIntent");
      try {
        await run();
        expect(refundSpy.calls.length).toBe(0);
        expect(intentSpy.calls.length).toBe(0);
      } finally {
        refundSpy.restore();
        intentSpy.restore();
      }
    });

  /** Run `body` with Stripe's refund answering `result`, and return the
   *  arguments it was actually called with. Stubbed, not spied: a spy keeps
   *  the real method, so the refund would leave for Stripe itself. */
  const withRefundAnswering =
    (result: Awaited<ReturnType<typeof stripeApi.refundPayment>>) =>
    async (body: () => Promise<void>): Promise<unknown[][]> => {
      const refundStub = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(result),
      );
      await withStripeConfigured(async () => {
        try {
          await body();
        } finally {
          refundStub.restore();
        }
      });
      return refundStub.calls.map((call) => call.args);
    };

  const withSucceedingRefund = withRefundAnswering(succeededRefund);
  /** Stripe refusing the refund: it reports nothing refunded. */
  const withRefusedRefund = withRefundAnswering(null);

  /** A refundable malformed-charge rejection this instance signed, so its
   *  ownership check passes and the refund goes ahead. */
  const ourRejection = (paymentReference: string) => ({
    metadata: signedMeta(
      { email: "a@example.com", items: "[]", name: "A" },
      500,
    ),
    paymentReference,
    reason: "malformed_charge" as const,
    refundable: true,
  });

  it("refuses an empty provider resource id before any provider call", () =>
    withStripeProvider(async () => {
      expect(await tryRefund("")).toBe(false);
    }));

  it("refuses a whitespace-only provider resource id before any provider call", () =>
    withStripeProvider(async () => {
      expect(await tryRefund("   ")).toBe(false);
      expect(await tryRefund("\t\n")).toBe(false);
    }));

  it("refunds a rejected paid charge whose price proof verifies", async () => {
    expect(
      await withSucceedingRefund(async () => {
        expect(await refundRejectedCharge(ourRejection("pi_usable"))).toBe(
          true,
        );
      }),
    ).toEqual([["pi_usable"]]);
  });

  it("does not refund a rejection whose price proof does not verify", () =>
    withStripeProvider(async () => {
      // A foreign instance signed with its own key, so the proof must not
      // pass and no refund may be issued from here.
      expect(
        await refundRejectedCharge({
          metadata: {
            ...signedMeta(
              { email: "a@example.com", items: "[]", name: "A" },
              500,
            ),
            price_proof: "500.deadbeef",
          },
          paymentReference: "pi_foreign",
          reason: "malformed_charge",
          refundable: true,
        }),
      ).toBe(true);
    }));

  it("does not refund a rejection whose metadata carries no price proof", () =>
    withStripeProvider(async () => {
      // Legacy/unsigned sessions carry an empty proof, so nothing can prove
      // the charge is ours and no refund may be issued.
      expect(
        await refundRejectedCharge({
          metadata: webhookMeta({
            email: "a@example.com",
            items: "[]",
            name: "A",
          }),
          paymentReference: "pi_noproof",
          reason: "malformed_charge",
          refundable: true,
        }),
      ).toBe(true);
    }));

  it("does not refund a blank-reference rejection", () =>
    withStripeProvider(async () => {
      expect(await refundRejectedCharge({ reason: "blank_reference" })).toBe(
        true,
      );
    }));

  it("reports a successful rejection refund as a settled 400", async () => {
    expect(
      await withSucceedingRefund(async () => {
        expect(await refundRejectedSession(ourRejection("pi_settled"))).toEqual(
          { refunded: true, status: 400 },
        );
      }),
    ).toEqual([["pi_settled"]]);
  });

  it("reports a failed rejection refund as a retryable 503", async () => {
    // The provider refuses the refund and reports nothing refunded, so the
    // caller must answer retryable rather than acknowledge the charge away.
    expect(
      await withRefusedRefund(async () => {
        expect(await refundRejectedSession(ourRejection("pi_stuck"))).toEqual({
          refunded: false,
          status: 503,
        });
      }),
    ).toEqual([["pi_stuck"]]);
  });
});
