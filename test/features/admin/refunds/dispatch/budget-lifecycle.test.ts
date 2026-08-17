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

test("an over-budget batch makes zero durable authority or provider calls", async () => {
  const attendeeIds = [72, 73];
  const references = ["pi_budget_a", "pi_budget_b"];
  const sessionIds = references.map((reference) => `sess_${reference}`);
  const source = provider();
  const claim = grantingRowClaim(
    new Map(
      attendeeIds.map((attendeeId, position) => [
        attendeeId,
        [sessionIds[position]!],
      ]),
    ),
  );
  const prepare = prepareAtProvider(source);
  const dispatchCost = refundPreparedSubrequestCost({
    activeAuthorityCount: references.length,
    mayRecordReturns: true,
    returnedAuthorityCount: 0,
    sendReferences: references.map((reference) => ({
      index: `index_of_stripe_${reference}`,
      provider: "stripe" as const,
    })),
  });
  let authorityCalled = false;

  const result = await processRefundBatch(
    references.map((reference, position) =>
      candidateWithReferences(
        [rowBackedReference(reference, sessionIds[position]!)],
        attendeeIds[position]!,
      ),
    ),
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
  // The late dispatch refusal still lets go of every held row.
  expect(claim.released).toEqual([sessionIds]);
});
