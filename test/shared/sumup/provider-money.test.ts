import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
} from "#shared/payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { SumupRefundSubmission } from "#shared/sumup/failures.ts";
import type { SumupTransactionMoney } from "#shared/sumup/transaction.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  chargeMoney,
  fullyRefundedMoney,
  gbp,
} from "#test-utils/payment-state.ts";

const transaction = (
  refundEvents: SumupTransactionMoney["refundEvents"],
): SumupTransactionMoney => ({ amount: 10, currency: "GBP", refundEvents });

const transactionRead = (
  resource: SumupTransactionMoney,
): ProviderRead<SumupTransactionMoney> => ({ resource, status: "found" });

const failedRefundCharge = (): ChargeMoney => ({
  ...chargeMoney(1000),
  refunds: [
    {
      amount: gbp(1000),
      reason: "provider_failed",
      status: "failed",
    },
  ],
});

const EXPECTS_FRESH_READ = {
  not_sent: false,
  rejected: true,
  sent: true,
  uncertain: true,
} satisfies Record<SumupRefundSubmission["kind"], boolean>;

const readCharge = async (read: ProviderRead<SumupTransactionMoney>) => {
  const answer: { read?: ProviderRead<ChargeMoney> } = {};
  await withMocks(
    () => stub(sumupApi, "readTransactionMoney", () => Promise.resolve(read)),
    async () => {
      answer.read = await sumupPaymentProvider.readCharge("txn");
    },
  );
  return answer.read;
};

describe("sumup provider money", () => {
  test("reads a transaction with no refund events as nothing back", async () => {
    expect(await readCharge(transactionRead(transaction([])))).toEqual({
      resource: {
        captured: gbp(1000),
        confirmedRefunded: gbp(0),
        refunds: [],
      },
      status: "found",
    });
  });

  for (const [name, events, expected] of [
    [
      "completed",
      [{ amount: 4, status: "REFUNDED" }],
      { amount: gbp(400), status: "completed" },
    ],
    [
      "pending",
      [{ amount: 10, status: "PENDING" }],
      { amount: gbp(1000), status: "pending" },
    ],
    [
      "failed",
      [{ amount: 10, status: "FAILED" }],
      { amount: gbp(1000), reason: "provider_failed", status: "failed" },
    ],
  ] as const) {
    test(`maps a ${name} refund event`, async () => {
      const read = await readCharge(transactionRead(transaction([...events])));
      expect(read).toEqual({
        resource: {
          captured: gbp(1000),
          confirmedRefunded: gbp(0),
          refunds: [expected],
        },
        status: "found",
      });
    });
  }

  for (const [name, events, reason] of [
    [
      "undocumented status",
      [{ amount: 4, status: "WAT" }],
      "unsupported_status",
    ],
    [
      "irrelevant status",
      [{ amount: 4, status: "PAID_OUT" }],
      "unsupported_status",
    ],
    [
      "missing status",
      [{ amount: 4, status: undefined }],
      "unsupported_status",
    ],
    [
      "missing amount",
      [{ amount: undefined, status: "REFUNDED" }],
      "malformed_money",
    ],
  ] as const) {
    test(`refuses a refund event with ${name}`, async () => {
      expect(
        await readCharge(transactionRead(transaction([...events]))),
      ).toEqual({ reason, status: "invalid" });
    });
  }

  for (const resource of [
    { amount: undefined, currency: "GBP", refundEvents: [] },
    { amount: 10, currency: undefined, refundEvents: [] },
    { amount: 10.001, currency: "GBP", refundEvents: [] },
    { amount: 10, currency: "GB", refundEvents: [] },
  ] satisfies SumupTransactionMoney[]) {
    test("refuses transaction money with a missing required value", async () => {
      expect(await readCharge(transactionRead(resource))).toEqual({
        reason: "malformed_money",
        status: "invalid",
      });
    });
  }

  for (const read of [
    { status: "missing" },
    { reason: "rate_limited", status: "unavailable" },
    { reason: "malformed_response", status: "invalid" },
  ] as const satisfies ProviderRead<SumupTransactionMoney>[]) {
    test(`preserves a transaction read that is ${read.status}`, async () => {
      expect(await readCharge(read)).toEqual(read);
    });
  }

  describe("refundCharge", () => {
    const request = authorizeDurableRefundSend(
      {
        charge: chargeMoney(1000),
        paymentReference: "txn_9",
      },
      {
        capability: "keyless",
        generation: 1,
        identityIndex: "test-refund-index:txn_9:1",
        provider: "sumup",
      },
    );

    test("refuses another provider's authority before sending", async () => {
      const stripeRequest = authorizeDurableRefundSend(
        {
          charge: chargeMoney(1000),
          paymentReference: "txn_9",
        },
        {
          capability: "keyed",
          generation: 1,
          idempotencyKey: "stripe-test-key",
          identityIndex: "stripe-test-request",
          provider: "stripe",
        },
      );
      using send = stub(sumupApi, "refundTransaction", () =>
        Promise.resolve({ kind: "sent" }),
      );

      await expect(
        sumupPaymentProvider.refundCharge(stripeRequest),
      ).rejects.toThrow("authorization does not permit sumup");
      expect(send.calls).toHaveLength(0);
    });

    const refund = async (
      submission: SumupRefundSubmission,
      fresh: ProviderRead<ChargeMoney> = {
        resource: chargeMoney(1000),
        status: "found",
      },
      attemptedRequest: AuthorizedRefundRequest<"sumup"> = request,
    ) => {
      const answer: { result?: RefundAttemptResult } = {};
      await withMocks(
        () => ({
          read: stub(sumupPaymentProvider, "readCharge", () =>
            Promise.resolve(fresh),
          ),
          send: stub(sumupApi, "refundTransaction", () =>
            Promise.resolve(submission),
          ),
        }),
        async (mocks) => {
          answer.result =
            await sumupPaymentProvider.refundCharge(attemptedRequest);
          expect(mocks.send.calls[0]?.args).toEqual([
            attemptedRequest.paymentReference,
          ]);
          expect(mocks.read.calls).toHaveLength(
            EXPECTS_FRESH_READ[submission.kind] ? 1 : 0,
          );
        },
      );
      return answer.result;
    };

    for (const [name, submission] of [
      ["a sent request", { kind: "sent" }],
      [
        "an ambiguous provider conflict",
        { kind: "uncertain", reason: "provider_error" },
      ],
    ] as const satisfies readonly (readonly [
      string,
      SumupRefundSubmission,
    ])[]) {
      test(`calls a fully observed refund completed after ${name}`, async () => {
        const fresh = fullyRefundedMoney(1000);
        expect(
          await refund(submission, { resource: fresh, status: "found" }),
        ).toEqual({
          amount: gbp(1000),
          kind: "completed",
          proof: { charge: fresh, kind: "charge_observation" },
        });
      });
    }

    test("recognises money returned beside a rejected send", async () => {
      const fresh = fullyRefundedMoney(1000);
      expect(
        await refund(
          { kind: "rejected", reason: "rejected" },
          { resource: fresh, status: "found" },
        ),
      ).toEqual({
        amount: gbp(1000),
        kind: "completed",
        proof: { charge: fresh, kind: "charge_observation" },
      });
    });

    for (const [name, submission] of [
      ["a sent request", { kind: "sent" }],
      [
        "a lost network answer",
        {
          kind: "uncertain",
          reason: "network_error",
        },
      ],
    ] as const satisfies readonly (readonly [
      string,
      SumupRefundSubmission,
    ])[]) {
      test(`keeps the requested amount when SumUp shows it pending after ${name}`, async () => {
        const fresh: ChargeMoney = {
          ...chargeMoney(1000),
          refunds: [{ amount: gbp(1000), status: "pending" }],
        };
        expect(
          await refund(submission, { resource: fresh, status: "found" }),
        ).toEqual({
          amount: gbp(1000),
          kind: "accepted",
          proof: { charge: fresh, kind: "charge_observation" },
        });
      });
    }

    test("keeps a sent refund uncertain while a fresh read shows no refund", async () => {
      expect(await refund({ kind: "sent" })).toEqual({
        kind: "uncertain",
        reason: "missing_documented_resource",
      });
    });

    test("keeps a sent refund uncertain when only part is pending", async () => {
      const fresh: ChargeMoney = {
        ...chargeMoney(1000),
        refunds: [{ amount: gbp(400), status: "pending" }],
      };
      expect(
        await refund({ kind: "sent" }, { resource: fresh, status: "found" }),
      ).toEqual({ kind: "uncertain", reason: "mismatched_money" });
    });

    test("keeps two pending refunds uncertain when together they cover the charge", async () => {
      const fresh: ChargeMoney = {
        ...chargeMoney(1000),
        refunds: [
          { amount: gbp(400), status: "pending" },
          { amount: gbp(600), status: "pending" },
        ],
      };
      expect(
        await refund({ kind: "sent" }, { resource: fresh, status: "found" }),
      ).toEqual({ kind: "uncertain", reason: "multiple_pending_refunds" });
    });

    test("rejects a send when fresh evidence adds a failed refund", async () => {
      const fresh = failedRefundCharge();
      expect(
        await refund(
          { kind: "uncertain", reason: "network_error" },
          { resource: fresh, status: "found" },
        ),
      ).toEqual({ kind: "rejected", reason: "failed" });
    });

    test("does not mistake an old failed refund for the new send", async () => {
      const priorCharge = failedRefundCharge();
      expect(
        await refund(
          { kind: "uncertain", reason: "network_error" },
          { resource: priorCharge, status: "found" },
          authorizeDurableRefundSend(
            { charge: priorCharge, paymentReference: "txn_9" },
            request.authorization,
          ),
        ),
      ).toEqual({ kind: "uncertain", reason: "network_error" });
    });

    for (const fresh of [chargeMoney(2000), chargeMoney(1000, 0, "USD")]) {
      test("refuses a fresh observation for different charge money", async () => {
        expect(
          await refund({ kind: "sent" }, { resource: fresh, status: "found" }),
        ).toEqual({ kind: "uncertain", reason: "mismatched_money" });
      });
    }

    for (const [read, reason] of [
      [{ status: "missing" }, "missing_documented_resource"],
      [{ reason: "timeout", status: "unavailable" }, "timeout"],
      [{ reason: "malformed_money", status: "invalid" }, "malformed_money"],
    ] as const) {
      test(`never completes after a ${read.status} verification`, async () => {
        expect(await refund({ kind: "sent" }, read)).toEqual({
          kind: "uncertain",
          reason,
        });
      });
    }

    for (const outcome of [
      { kind: "not_sent", reason: "not_configured" },
      { kind: "rejected", reason: "rejected" },
    ] as const satisfies SumupRefundSubmission[]) {
      test(`preserves a ${outcome.kind} send outcome`, async () => {
        expect(await refund(outcome)).toEqual(outcome);
      });
    }

    for (const reason of [
      "malformed_response",
      "network_error",
      "provider_error",
    ] as const) {
      test(`preserves an uncertain ${reason} while fresh evidence is unchanged`, async () => {
        expect(await refund({ kind: "uncertain", reason })).toEqual({
          kind: "uncertain",
          reason,
        });
      });
    }
  });
});
