import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { taggedRefundReference } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  candidateWithReferences,
  finishedCounts,
  observedReference,
  provider,
  readyCandidateFrom,
} from "./helpers.ts";
import { recordEveryRefund } from "./ledger-results.ts";

describeWithEnv(
  "admin refund provider > mixed capabilities",
  { db: true },
  () => {
    test("one authority request handles mixed provider references", async () => {
      const stripe = provider({
        paymentProvider: "stripe",
        refunded: new Set(["stripe_retry"]),
      });
      const sumup = provider({
        paymentProvider: "sumup",
        refundCapability: "keyless",
      });
      const references = await Promise.all(
        [
          taggedRefundReference("stripe_retry", "stripe"),
          taggedRefundReference("sumup_returned", "sumup", {
            refundState: "completed",
          }),
        ].map(async (reference) => {
          const index = await paymentReferenceIndex(reference);
          return { ...reference, index, matchingIndexes: [index] };
        }),
      );
      const stripeReference = references[0]!;
      const sumupReference = references[1]!;
      await markProviderRefundsReturned([sumupReference]);
      const source = candidateWithReferences(references);
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
                readyCandidateFrom(source, [
                  observedReference(stripeReference, stripe),
                  {
                    kind: "already_returned",
                    provider: sumup,
                    reference: sumupReference,
                  },
                ]),
              ],
              kind: "ready",
            }),
          record: recordEveryRefund,
          recordAuthorities: recordProviderRefunds,
          request: requestProviderRefund,
        }),
      );

      expect(stripe.refunds).toEqual(["stripe_retry"]);
      expect(sumup.refunds).toEqual([]);
      expect(counts.refundedCount).toBe(1);
      expect(rowClaim.released).toEqual([
        ["sess_stripe_retry", "sess_sumup_returned"],
      ]);
    });
  },
);
