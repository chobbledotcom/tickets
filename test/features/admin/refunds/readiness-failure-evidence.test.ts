import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import { refundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  found,
  heldClaim,
  stripeReadiness,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  fullyRefundedMoney,
  refundReference,
} from "#test-utils/payment-state.ts";

describe("admin refund readiness failure evidence", () => {
  test("carries a returned sibling observation when another read fails", async () => {
    const returned = tagged("returned", "stripe", "returned_index");
    const unread = tagged("unread", "stripe", "unread_index");
    const result = await prepareRefundReadiness(
      [
        {
          attendee: { id: 7 } as RefundCandidate["attendee"],
          references: [returned, unread],
        },
      ],
      {
        ...heldClaim,
        held: new Map([[7, [...returned.rowSessionIds, ...unread.rowSessionIds]]]),
        phases: new Map(
          [...returned.rowSessionIds, ...unread.rowSessionIds].map(
            (sessionId) => [sessionId, "checking" as const],
          ),
        ),
      },
      new Set(),
      stripeReadiness((reference) =>
        Promise.resolve(
          reference.index === returned.index
            ? found(reference, "stripe", fullyRefundedMoney())
            : {
                attempts: [
                  {
                    provider: "stripe",
                    result: { reason: "timeout", status: "unavailable" },
                  },
                ],
                provider: "stripe",
                reason: "timeout",
                reference: reference.reference,
                source: "tagged",
                status: "unavailable",
              },
        )
      ),
    );

    expect(result).toMatchObject({
      kind: "not_ready",
      observations: [{ charge: fullyRefundedMoney(), index: returned.index }],
      reason: "provider_evidence",
    });
  });

  test("protects a known return before readiness itself throws", async () => {
    const attendeeId = 8;
    const reference = refundReference("known_return", {
      refundState: "completed",
    });
    const claim = grantingRowClaim(
      new Map([[attendeeId, reference.rowSessionIds]]),
    );

    await expect(
      processRefundBatch(
        [
          {
            attendee: { id: attendeeId } as RefundCandidate["attendee"],
            references: [reference],
          },
        ],
        3,
        {
          claim,
          prepare: () => Promise.reject(new Error("provider read crashed")),
          record: (postings) =>
            Promise.resolve(
              new Map(
                postings.map(({ attendeeId, references }) => [
                  attendeeId,
                  refundLedgerResult(references),
                ]),
              ),
            ),
        },
      ),
    ).rejects.toThrow("provider read crashed");

    expect(claim.unrecorded).toEqual([reference.rowSessionIds]);
    expect(claim.released).toEqual([reference.rowSessionIds]);
  });
});
