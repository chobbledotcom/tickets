import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import { requestRecordedProviderRefund } from "./dispatch-helpers.ts";
import {
  candidate,
  finishedCounts,
  provider,
  readyCandidate,
} from "./helpers.ts";
import { recordEveryRefund } from "./ledger-results.ts";

test("one authority request handles mixed provider references", async () => {
  const stripe = provider({
    paymentProvider: "stripe",
    refunded: new Set(["stripe_retry"]),
  });
  const sumup = provider({
    paymentProvider: "sumup",
    refundCapability: "keyless",
  });
  const source = candidate([
    { reference: "stripe_retry" },
    { reference: "sumup_returned", refundState: "completed" },
  ]);
  const rowClaim = grantingRowClaim(
    new Map([
      [42, source.references.flatMap(({ rowSessionIds }) => rowSessionIds)],
    ]),
  );

  const counts = finishedCounts(
    await processRefundBatch([source], 7, {
      claim: rowClaim,
      prepare: () =>
        Promise.resolve({
          candidates: [
            readyCandidate(
              [
                {
                  index: "stripe_retry_index",
                  provider: stripe,
                  reference: "stripe_retry",
                },
                {
                  index: "sumup_returned_index",
                  kind: "already_returned",
                  provider: sumup,
                  reference: "sumup_returned",
                },
              ],
              stripe,
            ),
          ],
          kind: "ready",
        }),
      record: recordEveryRefund,
      recordAuthorities: () => Promise.resolve(),
      request: requestRecordedProviderRefund,
    }),
  );

  expect(stripe.refunds).toEqual(["stripe_retry"]);
  expect(sumup.refunds).toEqual([]);
  expect(counts.refundedCount).toBe(1);
  expect(rowClaim.released).toEqual([
    ["sess_stripe_retry", "sess_sumup_returned"],
  ]);
});
