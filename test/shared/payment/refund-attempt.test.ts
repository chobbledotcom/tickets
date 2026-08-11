import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  refundOutcomeAfterReread,
} from "#shared/payment/refund-attempt.ts";
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
} from "#test-utils/payment-state.ts";

const request: RefundRequest = {
  charge: chargeMoney(),
  paymentReference: "provider_reread",
};

const uncertain = {
  kind: "uncertain",
  reason: "network_error",
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

  for (const [name, read] of [
    ["missing", { status: "missing" }],
    ["unavailable", { reason: "timeout", status: "unavailable" }],
    ["invalid", { reason: "malformed_money", status: "invalid" }],
  ] as const satisfies readonly (readonly [
    string,
    ProviderRead<ChargeMoney>,
  ])[]) {
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

type RefundSender = Pick<PaymentProvider, "refundCharge">;

interface RereadAdapter {
  readonly name: string;
  readonly provider: PaymentProvider;
  readonly sender: RefundSender;
}

const refundAfterRead = async (
  { provider, sender }: RereadAdapter,
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
      result = await provider.refundCharge(request);
      expect(mocks.read.calls).toHaveLength(
        attempt.kind === "uncertain" ? 1 : 0,
      );
    },
  );
  return { calls, result };
};

for (const adapter of [
  { name: "Stripe", provider: stripePaymentProvider, sender: stripeApi },
  { name: "Square", provider: squarePaymentProvider, sender: squareApi },
] satisfies RereadAdapter[]) {
  describe(`${adapter.name} uncertain refund reread`, () => {
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

    test("does not reread a definitive provider answer", async () => {
      const rejected = { kind: "rejected", reason: "rejected" } as const;
      expect(await refundAfterRead(adapter, chargeMoney(), rejected)).toEqual({
        calls: ["send"],
        result: rejected,
      });
    });
  });
}
