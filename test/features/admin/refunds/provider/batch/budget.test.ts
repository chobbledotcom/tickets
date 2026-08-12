import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import {
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const TOO_MANY_FOR_RUN =
  "This run has too many payments to refund at once. Refund fewer attendees at a time.";

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

const stripeReference = (
  attendeeId: number,
  offset: number,
): TaggedReference => {
  const reference = `pi_budget_${attendeeId}_${offset}`;
  const index = `index_of_stripe_${reference}`;
  const sessionId = `session_${reference}`;
  return {
    heldRowSessionIds: [],
    index,
    kind: "tagged",
    matchingIndexes: [index],
    provider: "stripe",
    reference,
    refundState: "none",
    rowSessionIds: [sessionId],
    sessionIds: [sessionId],
  };
};

const candidate = (attendeeId: number, referenceCount: number) => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: Array.from({ length: referenceCount }, (_, offset) =>
    stripeReference(attendeeId, offset),
  ),
});

describe("admin refund provider > whole-command budget", () => {
  test("six Stripe payments on one attendee make zero provider calls", async () => {
    const source = provider();
    let claims = 0;
    const granted = grantingRowClaim();

    const result = await processRefundBatchAt(source, [candidate(11, 6)], 7, {
      claim: {
        claim: (attendees) => {
          claims++;
          return granted.claim(attendees);
        },
        settle: granted.settle,
      },
      record: recordEveryRefund,
    });

    expect(result).toMatchObject({
      kind: "not_ready",
      message: TOO_MANY_FOR_RUN,
    });
    expect(claims).toBe(0);
    expect(source.reads).toEqual([]);
    expect(source.refunds).toEqual([]);
  });

  test("an oversized bulk command refuses every attendee before provider work", async () => {
    const source = provider();
    const candidates = Array.from({ length: 6 }, (_, offset) =>
      candidate(20 + offset, 1),
    );
    let claims = 0;
    const granted = grantingRowClaim();

    const result = await processRefundBatchAt(source, candidates, 7, {
      claim: {
        claim: (attendees) => {
          claims++;
          return granted.claim(attendees);
        },
        settle: granted.settle,
      },
      record: recordEveryRefund,
    });

    expect(result).toMatchObject({
      kind: "not_ready",
      message: TOO_MANY_FOR_RUN,
    });
    expect(claims).toBe(0);
    expect(source.reads).toEqual([]);
    expect(source.refunds).toEqual([]);
  });
});
