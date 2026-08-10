import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import {
  answerRejectedSession,
  refundRejectedCharge,
  tryRefund,
} from "#routes/api/payment-processing/refunds.ts";
import { settings } from "#shared/db/settings.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { signedMeta, webhookMeta } from "#test-utils/factories.ts";
import { stripeIntentWithCharge } from "#test-utils/stripe/responses.ts";

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
  /** Run `body` with Stripe as the provider a refund resolves to. The key has
   *  to be there as well as the choice: an existing payment is only refunded
   *  through a provider this site still holds credentials for. */
  const withStripeConfigured = async <T>(
    body: () => Promise<T>,
  ): Promise<T> => {
    const original = paymentsApi.getConfiguredProvider;
    paymentsApi.getConfiguredProvider = () => "stripe";
    settings.setForTest({ stripe_secret_key: "sk_test_rejected_charge" });
    try {
      return await body();
    } finally {
      settings.clearTestOverrides();
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

  /** Run `body` with Stripe.s refund answering `answer`, handing back what it
   *  returned and the arguments the refund was actually called with. Stubbed,
   *  not spied: a spy keeps the real method, so the refund would leave for
   *  Stripe itself. */
  const withRefundAnswering =
    (answer: Awaited<ReturnType<typeof stripeApi.refundPayment>>) =>
    async <T>(
      body: () => Promise<T>,
    ): Promise<{ calls: unknown[][]; result: T }> => {
      const refundStub = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(answer),
      );
      // The refund asks what the money has already done before sending any, so
      // the charge must read as one nothing has come back on for the refund to
      // be admitted at all.
      const intentStub = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve(stripeIntentWithCharge()),
      );
      try {
        const result = await withStripeConfigured(body);
        return { calls: refundStub.calls.map((call) => call.args), result };
      } finally {
        intentStub.restore();
        refundStub.restore();
      }
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
    const { calls, result } = await withSucceedingRefund(() =>
      refundRejectedCharge(ourRejection("pi_usable")),
    );
    expect(calls).toEqual([["pi_usable"]]);
    expect(result).toEqual({ refunded: true, settled: true });
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
      ).toEqual({ refunded: false, settled: true });
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
      ).toEqual({ refunded: false, settled: true });
    }));

  it("does not refund a blank-reference rejection", () =>
    withStripeProvider(async () => {
      expect(await refundRejectedCharge({ reason: "blank_reference" })).toEqual(
        { refunded: false, settled: true },
      );
    }));

  /** Run the callbacks' answer for a rejection, collecting what it logged. */
  const answerFor = async (
    reference: string,
  ): Promise<{ status: number; page: string; logged: string[] }> => {
    const logged: string[] = [];
    const response = await answerRejectedSession(
      ourRejection(reference),
      `cs_${reference}`,
      (detail) => logged.push(detail),
    );
    return { logged, page: await response.text(), status: response.status };
  };

  it("tells a buyer whose charge came back, and settles it at 400", async () => {
    const { calls, result } = await withSucceedingRefund(() =>
      answerFor("pi_settled"),
    );
    expect(calls).toEqual([["pi_settled"]]);
    expect(result.status).toBe(400);
    expect(result.page).toContain("sent your money back");
    expect(result.logged).toEqual([
      "Session rejected as malformed_charge (session=cs_pi_settled, refunded: true)",
    ]);
  });

  it("asks for a retry at 503 when the provider refuses the refund", async () => {
    // Nothing came back, so the buyer must not be told it did — and the caller
    // must retry rather than acknowledge the charge away.
    const { calls, result } = await withRefusedRefund(() =>
      answerFor("pi_stuck"),
    );
    expect(calls).toEqual([["pi_stuck"]]);
    expect(result.status).toBe(503);
    expect(result.page).not.toContain("sent your money back");
    expect(result.logged).toEqual([
      "Session rejected as malformed_charge (session=cs_pi_stuck, refunded: false)",
    ]);
  });
});
