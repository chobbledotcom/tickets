import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  refundOutcomeAfterReread,
} from "#shared/payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
} from "#shared/payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  gbp,
  refundObservation,
  unreadChargeCases,
} from "#test-utils/payment-state.ts";

const request: RefundRequest = {
  charge: chargeMoney(),
  paymentReference: "provider_reread",
};

const uncertain = {
  kind: "uncertain",
  reason: "network_error",
} as const satisfies RefundAttemptResult;

const rejected = {
  kind: "rejected",
  reason: "rejected",
} as const satisfies RefundAttemptResult;

const completedAfter = (charge: ChargeMoney): RefundAttemptResult => ({
  amount: request.charge.captured,
  kind: "completed",
  proof: { charge, kind: "charge_observation" },
});

const judge = (freshCharge: ProviderRead<ChargeMoney>): RefundAttemptResult =>
  refundOutcomeAfterReread({ attempt: uncertain, freshCharge, request });

describe("uncertain refund reread judgment", () => {
  test("completes only from an exact fully refunded charge", () => {
    const charge = chargeMoney(1000, 1000);
    expect(judge({ resource: charge, status: "found" })).toEqual(
      completedAfter(charge),
    );
  });

  for (const [name, read] of unreadChargeCases) {
    test(`preserves the uncertain answer after a ${name} read`, () => {
      expect(judge(read)).toEqual(uncertain);
    });
  }

  for (const [name, charge] of [
    ["amount", chargeMoney(900, 900)],
    ["currency", chargeMoney(1000, 1000, "USD")],
  ] as const) {
    test(`refuses a fresh charge with a different captured ${name}`, () => {
      expect(judge({ resource: charge, status: "found" })).toEqual({
        kind: "uncertain",
        reason: "mismatched_money",
      });
    });
  }

  for (const [name, charge] of [
    ["no refund", chargeMoney()],
    [
      "pending refund",
      chargeMoneyWith({
        captured: gbp(1000),
        refunds: [refundObservation({ amount: gbp(1000), status: "pending" })],
      }),
    ],
    ["partial refund", chargeMoney(1000, 400)],
    ["over-refund", chargeMoney(1000, 1200)],
  ] as const) {
    test(`preserves the uncertain answer after observing ${name}`, () => {
      expect(judge({ resource: charge, status: "found" })).toEqual(uncertain);
    });
  }
});

describe("rejected refund reread judgment", () => {
  for (const [name, freshCharge, reason] of [
    ["missing", { status: "missing" }, "missing_documented_resource"],
    ["unavailable", { reason: "timeout", status: "unavailable" }, "timeout"],
    [
      "invalid",
      { reason: "malformed_money", status: "invalid" },
      "malformed_money",
    ],
  ] as const satisfies readonly (readonly [
    string,
    ProviderRead<ChargeMoney>,
    Extract<RefundAttemptResult, { kind: "uncertain" }>["reason"],
  ])[]) {
    test(`keeps the recovery target protected after a ${name} read`, () => {
      expect(
        refundOutcomeAfterReread({ attempt: rejected, freshCharge, request }),
      ).toEqual({ kind: "uncertain", reason });
    });
  }
});

type RefundSender = Pick<PaymentProvider, "refundCharge">;

interface RereadAdapter {
  readonly name: string;
  readonly provider: PaymentProvider;
  readonly request: AuthorizedRefundRequest;
  readonly sender: RefundSender;
  readonly wrongRequest: AuthorizedRefundRequest;
}

const refundAfterRead = async (
  { provider, request: authorizedRequest, sender }: RereadAdapter,
  charge: ChargeMoney,
  attempt: RefundAttemptResult = uncertain,
): Promise<{
  calls: string[];
  result: RefundAttemptResult;
}> => {
  const calls: string[] = [];
  let result: RefundAttemptResult = attempt;
  await withMocks(
    () => ({
      read: stub(provider, "readCharge", () => {
        calls.push("read");
        return Promise.resolve({ resource: charge, status: "found" });
      }),
      send: stub(sender, "refundCharge", () => {
        calls.push("send");
        return Promise.resolve(attempt);
      }),
    }),
    async (mocks) => {
      result = await provider.refundCharge(authorizedRequest);
      expect(mocks.read.calls).toHaveLength(
        attempt.kind === "uncertain" || attempt.kind === "rejected" ? 1 : 0,
      );
    },
  );
  return { calls, result };
};

const stripeAuthorizedRequest = authorizeDurableRefundSend(request, {
  capability: "keyed",
  generation: 1,
  idempotencyKey: "stripe-test-key",
  identityIndex: "stripe-test-request",
  provider: "stripe",
});
const squareAuthorizedRequest = authorizeDurableRefundSend(request, {
  capability: "keyed",
  generation: 1,
  idempotencyKey: "square-test-key",
  identityIndex: "square-test-request",
  provider: "square",
});

for (const adapter of [
  {
    name: "Stripe",
    provider: stripePaymentProvider,
    request: stripeAuthorizedRequest,
    sender: stripeApi,
    wrongRequest: squareAuthorizedRequest,
  },
  {
    name: "Square",
    provider: squarePaymentProvider,
    request: squareAuthorizedRequest,
    sender: squareApi,
    wrongRequest: stripeAuthorizedRequest,
  },
] satisfies RereadAdapter[]) {
  describe(`${adapter.name} uncertain refund reread`, () => {
    test("refuses another provider's authority before sending", async () => {
      using send = stub(adapter.sender, "refundCharge", () =>
        Promise.resolve(uncertain),
      );

      await expect(
        adapter.provider.refundCharge(adapter.wrongRequest),
      ).rejects.toThrow("authorization does not permit");
      expect(send.calls).toHaveLength(0);
    });

    test("completes when one immediate read proves the exact charge returned", async () => {
      const charge = chargeMoney(1000, 1000);
      expect(await refundAfterRead(adapter, charge)).toEqual({
        calls: ["send", "read"],
        result: completedAfter(charge),
      });
    });

    test("stays uncertain after exactly one non-covering read", async () => {
      expect(await refundAfterRead(adapter, chargeMoney(1000, 400))).toEqual({
        calls: ["send", "read"],
        result: uncertain,
      });
    });

    test("completes when a rejected send is visible in one immediate read", async () => {
      const charge = chargeMoney(1000, 1000);
      expect(await refundAfterRead(adapter, charge, rejected)).toEqual({
        calls: ["send", "read"],
        result: completedAfter(charge),
      });
    });

    test("preserves a rejected send after one non-covering read", async () => {
      expect(await refundAfterRead(adapter, chargeMoney(), rejected)).toEqual({
        calls: ["send", "read"],
        result: rejected,
      });
    });

    for (const [state, charge] of [
      [
        "pending",
        chargeMoneyWith({
          captured: gbp(1000),
          refunds: [
            refundObservation({ amount: gbp(1000), status: "pending" }),
          ],
        }),
      ],
      ["partial", chargeMoney(1000, 400)],
    ] as const) {
      test(`protects a rejected send after observing a ${state} refund`, async () => {
        expect(await refundAfterRead(adapter, charge, rejected)).toEqual({
          calls: ["send", "read"],
          result: { kind: "uncertain", reason: "observed_refund" },
        });
      });
    }

    const completed = completedAfter(chargeMoney(1000, 1000));
    if (completed.kind !== "completed") {
      throw new Error("Completed refund fixture was not completed");
    }
    const accepted: RefundAttemptResult = { ...completed, kind: "accepted" };
    for (const [state, answer] of [
      ["accepted", accepted],
      ["completed", completed],
      ["not sent", { kind: "not_sent", reason: "not_configured" }],
    ] as const satisfies readonly (readonly [string, RefundAttemptResult])[]) {
      test(`does not reread a provider answer that was ${state}`, async () => {
        expect(await refundAfterRead(adapter, chargeMoney(), answer)).toEqual({
          calls: ["send"],
          result: answer,
        });
      });
    }
  });
}
