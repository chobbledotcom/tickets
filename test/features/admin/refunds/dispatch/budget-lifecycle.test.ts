import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { refundPreparedSubrequestCost } from "#routes/admin/refunds/budget.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
} from "#shared/subrequest-budget.ts";
import {
  candidateWithReferences,
  prepareAtProvider,
  provider,
  rowBackedReference,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

test("budget refusal happens before the durable authority is asked", async () => {
  const attendeeId = 72;
  const reference = "pi_budget";
  const index = `index_of_stripe_${reference}`;
  const sessionId = `sess_${reference}`;
  const source = provider();
  const claim = grantingRowClaim(new Map([[attendeeId, [sessionId]]]));
  const prepare = prepareAtProvider(source);
  const dispatchCost = refundPreparedSubrequestCost(
    {
      activeAuthorityCount: 1,
      mayRecordReturns: true,
      returnedAuthorityCount: 0,
      sendReferences: [{ index, provider: "stripe" }],
    },
    "before_authority_request",
  );
  let authorityCalled = false;

  const result = await processRefundBatch(
    [
      candidateWithReferences(
        [rowBackedReference(reference, sessionId)],
        attendeeId,
      ),
    ],
    7,
    {
      claim,
      prepare: async (...args) => {
        const ready = await prepare(...args);
        while (getSubrequestRemaining().total >= dispatchCost.total) {
          countSubrequest("database", "work before refund authority");
        }
        return ready;
      },
      request: () => {
        authorityCalled = true;
        throw new Error("the authority must not be asked");
      },
    },
  );

  expect(result).toMatchObject({
    kind: "not_ready",
    reason: "subrequest_budget",
  });
  expect(authorityCalled).toBe(false);
  expect(source.refunds).toEqual([]);
  expect(claim.released).toEqual([[sessionId]]);
});
