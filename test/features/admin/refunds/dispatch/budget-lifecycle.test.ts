import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundPreparedSubrequestCost } from "#routes/admin/refunds/budget.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
} from "#shared/subrequest-budget.ts";
import { armEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidateWithReferences,
  prepareAtProvider,
  provider,
  rowBackedReference,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

describe("admin refund dispatch > budget lifecycle", () => {
  test("a pre-arm refusal keeps inherited keyed work protected", async () => {
    const attendeeId = 72;
    const reference = "pi_inherited_budget";
    const index = `index_of_stripe_${reference}`;
    const sessionId = `sess_${reference}`;
    const source = provider();
    const claim = grantingRowClaim(
      new Map([[attendeeId, [sessionId]]]),
      new Map([[attendeeId, new Map([[index, "keyed" as const]])]]),
    );
    const prepare = prepareAtProvider(source);
    const dispatchCost = refundPreparedSubrequestCost(
      {
        mayRecordReturns: true,
        sendReferences: [{ index, provider: "stripe" }],
      },
      "before_dispatch_arm",
    );
    let armCalled = false;

    const result = await processRefundBatch(
      [
        candidateWithReferences(
          [rowBackedReference(reference, sessionId)],
          attendeeId,
        ),
      ],
      7,
      {
        arm: async (request) => {
          armCalled = true;
          return await armEveryRefund()(request);
        },
        claim,
        prepare: async (...args) => {
          const ready = await prepare(...args);
          while (getSubrequestRemaining().total >= dispatchCost.total) {
            countSubrequest("database", "work before refund dispatch");
          }
          return ready;
        },
      },
    );

    expect(result).toMatchObject({
      kind: "not_ready",
      reason: "subrequest_budget",
    });
    expect(armCalled).toBe(false);
    expect(source.refunds).toEqual([]);
    expect(claim.released).toEqual([]);
  });

  test("a keyless arm cannot spend the provider-send allowance", async () => {
    const attendeeId = 71;
    const reference = "pi_keyless_arm_budget";
    const index = `index_of_sumup_${reference}`;
    const sessionId = `sess_${reference}`;
    const source = provider({
      paymentProvider: "sumup",
      refundCapability: "keyless",
    });
    const claim = grantingRowClaim(new Map([[attendeeId, [sessionId]]]));
    const prepare = prepareAtProvider(source);
    const preparedBudget = {
      mayRecordReturns: true,
      sendReferences: [{ index, provider: "sumup" as const }],
    };
    const beforeArm = refundPreparedSubrequestCost(
      preparedBudget,
      "before_dispatch_arm",
    );
    const afterArm = refundPreparedSubrequestCost(
      preparedBudget,
      "before_provider_send",
    );
    const armDatabaseCalls = beforeArm.database - afterArm.database;
    const exactDispatchTotal = afterArm.total + armDatabaseCalls;
    const arm = armEveryRefund("keyless");
    let durableArmReached = false;

    const run = processRefundBatch(
      [
        candidateWithReferences(
          [rowBackedReference(reference, sessionId)],
          attendeeId,
        ),
      ],
      7,
      {
        arm: async (request) => {
          for (let call = 0; call <= armDatabaseCalls; call++) {
            countSubrequest("database", "refund arm retry");
          }
          durableArmReached = true;
          return await arm(request);
        },
        claim,
        prepare: async (...args) => {
          const ready = await prepare(...args);
          while (getSubrequestRemaining().total > exactDispatchTotal) {
            countSubrequest("database", "work before refund dispatch");
          }
          return ready;
        },
      },
    );

    await expect(run).rejects.toThrow("Subrequest allowance exceeded");
    expect(durableArmReached).toBe(false);
    expect(source.refunds).toEqual([]);
    expect(claim.released).toEqual([[sessionId]]);
  });
});
