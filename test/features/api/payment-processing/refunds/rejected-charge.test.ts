import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import type { SessionRejection } from "#payment/validated-session.ts";
import { refundRejectedCharge } from "#routes/api/payment-processing/refunds.ts";
import {
  answerRejectedSession,
  settleRejectedCharge,
} from "#routes/api/payment-processing/rejected-target.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import {
  ourRejection,
  withRefundAnswering,
  withStripeProvider,
  withSucceedingRefundFor,
} from "#test-utils/rejected-charge.ts";
import {
  completedStripeRefund,
  stripeRefundRequestShape,
} from "#test-utils/stripe/fixtures.ts";

setupTestEncryptionKey();

/** The receipt shape a completed rejection refund carries. */
const RETURNED_RECEIPT = {
  authority: {
    id: expect.any(Number),
    referenceIndex: expect.any(String),
    revision: expect.any(Number),
  },
  local: "due",
};

describeWithEnv("rejected session refunds", { db: true }, () => {
  const withSucceedingRefund = withSucceedingRefundFor(500);
  it("refunds a rejected paid charge whose price proof verifies", async () => {
    const { calls, result } = await withSucceedingRefund(() =>
      refundRejectedCharge(ourRejection("pi_usable")),
    );
    expect(calls).toEqual([[stripeRefundRequestShape("pi_usable", 500)]]);
    expect(result).toEqual({
      refunded: true,
      returned: RETURNED_RECEIPT,
      settled: true,
    });
  });

  it("uses the provider that validated the charge after the site switches", async () => {
    const { calls, result } = await withRefundAnswering(
      (request) =>
        completedStripeRefund(
          request.paymentReference,
          "re_original_provider",
          request.charge.captured.amount,
        ),
      500,
      "sumup",
    )(() => refundRejectedCharge(ourRejection("pi_before_switch")));

    expect(calls).toEqual([
      [stripeRefundRequestShape("pi_before_switch", 500)],
    ]);
    expect(result).toEqual({
      refunded: true,
      returned: RETURNED_RECEIPT,
      settled: true,
    });
  });

  for (const [name, operation, proof] of [
    [
      "does not refund a rejection whose price proof does not verify",
      refundRejectedCharge,
      "500.deadbeef",
    ],
    [
      "does not refund a rejection whose metadata carries no price proof",
      refundRejectedCharge,
      "",
    ],
    ["does not refund a blank-reference rejection", refundRejectedCharge, null],
    [
      "settles a blank-reference rejection without storing a target",
      settleRejectedCharge,
      null,
    ],
  ] as const) {
    it(name, () =>
      withStripeProvider(async () => {
        const metadata = webhookMeta({ items: "[]", name: "A" });
        const rejection: SessionRejection =
          proof === null
            ? {
                metadata,
                provider: "stripe",
                reason: "blank_reference",
                sessionId: "cs_blank",
              }
            : {
                metadata: { ...metadata, price_proof: proof },
                paymentReference: "pi_unowned",
                provider: "stripe",
                reason: "malformed_charge",
                refundable: true,
                sessionId: "cs_unowned",
              };
        expect(await operation(rejection)).toEqual({
          refunded: false,
          returned: null,
          settled: true,
        });
      }),
    );
  }

  /** Run the callbacks' answer for a rejection, collecting what it logged. */
  const answerFor = async (
    reference: string,
  ): Promise<{ status: number; page: string; logged: string[] }> => {
    const logged: string[] = [];
    const response = await answerRejectedSession(
      ourRejection(reference),
      (detail: string) => logged.push(detail),
    );
    return { logged, page: await response.text(), status: response.status };
  };

  for (const capturedAmount of [400, 600]) {
    it(`settles after refunding the exact observed ${capturedAmount} capture for a signed 500 rejection`, async () => {
      const reference = `pi_observed_${capturedAmount}`;
      const { calls, result } = await withSucceedingRefundFor(capturedAmount)(
        () => answerFor(reference),
      );
      expect(calls).toEqual([
        [stripeRefundRequestShape(reference, capturedAmount)],
      ]);
      expect(result.status).toBe(400);
      assertStringIncludes(result.page, "sent your money back");
      expect(result.logged).toEqual([
        `Session rejected as malformed_charge (session=cs_${reference}, refunded: true)`,
      ]);
    });
  }

  it("answers 503 for a charge left unsettled, so the caller comes back", async () => {
    const { result } = await withRefundAnswering(() => ({
      kind: "rejected",
      reason: "rejected",
    }))(() => answerFor("pi_refused"));
    expect(result.status).toBe(503);
    assertStringIncludes(
      result.page,
      "We could not find this payment session.",
    );
    expect(result.logged).toEqual([
      "Session rejected as malformed_charge (session=cs_pi_refused, refunded: false)",
    ]);
  });
});
