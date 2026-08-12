import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { REFUND_BUDGET_MESSAGES } from "#routes/admin/refunds/budget.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { REFUND_NETWORK_RETRIES } from "#shared/payment/refund-network.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
} from "#shared/subrequest-budget.ts";
import { armEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidate,
  candidateWithReferences,
  processRefundBatchAt,
  provider,
  rowBackedReference,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const postArmBudgetRace = () => {
  const arm = armEveryRefund();
  return async (request: Parameters<typeof arm>[0]) => {
    const armed = await arm(request);
    const sendEnvelope = 2 * (REFUND_NETWORK_RETRIES.stripe + 1);
    while (getSubrequestRemaining().total >= sendEnvelope) {
      countSubrequest("database", "work racing the dispatch arm");
    }
    return armed;
  };
};

const expectBudgetRefusal = (result: unknown): void => {
  expect(result).toMatchObject({
    kind: "not_ready",
    message: REFUND_BUDGET_MESSAGES.bulk,
    reason: "subrequest_budget",
  });
};

describe("admin refund provider > late budget lifecycle", () => {
  test("keeps inherited keyed work protected when no retry can fit", async () => {
    const attendeeId = 72;
    const reference = "pi_inherited_budget";
    const sessionId = `sess_${reference}`;
    const claim = grantingRowClaim(
      new Map([[attendeeId, [sessionId]]]),
      new Map([
        [
          attendeeId,
          new Map([[`index_of_stripe_${reference}`, "keyed" as const]]),
        ],
      ]),
    );
    const source = provider();

    const result = await processRefundBatchAt(
      source,
      [candidate([{ reference }], attendeeId)],
      7,
      { arm: postArmBudgetRace(), claim },
    );

    expectBudgetRefusal(result);
    expect(source.reads).toEqual([reference]);
    expect(source.refunds).toEqual([]);
    expect(claim.released).toEqual([]);
  });

  test("durably marks a returned sibling before releasing an unsent one", async () => {
    const attendeeId = 73;
    const returnedReference = "pi_returned_budget";
    const unsentReference = "pi_unsent_budget";
    const returnedSession = `sess_${returnedReference}`;
    const unsentSession = `sess_${unsentReference}`;
    const candidate: RefundCandidate = candidateWithReferences(
      [
        rowBackedReference(returnedReference, returnedSession),
        rowBackedReference(unsentReference, unsentSession),
      ],
      attendeeId,
    );
    const claim = grantingRowClaim(
      new Map([[attendeeId, [returnedSession, unsentSession]]]),
    );
    const source = provider({
      read: (reference) =>
        Promise.resolve(
          reference === returnedReference
            ? fullyRefundedMoney()
            : chargeMoney(),
        ),
    });

    const result = await processRefundBatchAt(source, [candidate], 7, {
      arm: postArmBudgetRace(),
      claim,
    });

    expectBudgetRefusal(result);
    expect(source.refunds).toEqual([]);
    expect(claim.unrecorded).toEqual([[returnedSession]]);
    expect(claim.released).toEqual([[returnedSession, unsentSession]]);
  });
});
