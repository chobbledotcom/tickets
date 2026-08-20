import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { readyRefund } from "#payment/refund-authority.ts";
import { withRefundWorkFacts } from "#shared/provider-refunds/work.ts";
import type { ProviderRefundWork } from "#shared/provider-refunds.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import { fakeRefundProvider, refundReference } from "./engine-helpers.ts";

test("refund work supplies the same named facts and untouched work", async () => {
  const charge = chargeMoney();
  const reference = refundReference("txn-work", "stripe");
  const target = {
    evidence: { charge, kind: "observed" as const },
    mode: "observe_only" as const,
    reference,
  };
  const work: ProviderRefundWork = {
    admission: { kind: "already_returned" },
    charge,
    now: 100,
    provider: fakeRefundProvider(
      "stripe",
      () => Promise.resolve({ resource: charge, status: "found" }),
      () => Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
    ),
    row: {
      callbackReplayIndex: null,
      captured: charge.captured,
      id: 7,
      provider: "stripe",
      referenceIndex: "blind-index",
      refunded: { amount: 0, currency: "GBP" },
      revision: 1,
      state: readyRefund({
        evidenceRevision: 1,
        nextActionAt: 100,
        now: 100,
        request: {
          capability: "keyed",
          generation: 1,
          identityIndex: "request-index",
          replayUntil: 200,
        },
      }),
    },
    target,
  };
  const step = withRefundWorkFacts((facts, untouched) => {
    expect(facts).toEqual({
      admission: work.admission,
      charge: work.charge,
      now: work.now,
      row: work.row,
      target: work.target,
    });
    expect(untouched).toBe(work);
    return Promise.resolve({ kind: "unchanged", reference });
  });

  expect(await step(work)).toMatchObject({ kind: "unchanged" });
});
