import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  refreshClaimedPayment,
  type RefreshPaymentDependencies,
} from "#routes/admin/refunds/refresh.ts";
import type {
  ReadyRefundProvider,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  candidate,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";

const LISTING_ID = 17;
const ATTENDEE_ID = 23;

const recordingProvider = (): ReadyRefundProvider & { sends: number } => {
  const source: ReadyRefundProvider & { sends: number } = {
    refundCapability: "keyed",
    refundCharge: () => {
      source.sends++;
      return Promise.resolve({ kind: "not_sent", reason: "not_configured" });
    },
    sends: 0,
    type: "stripe",
  };
  return source;
};

const readyResult = (
  reference: Extract<RefundPaymentReference, { kind: "tagged" }>,
  provider: ReadyRefundProvider,
): Extract<RefundReadinessResult, { kind: "ready" }> => ({
  candidates: [
    {
      attendee: candidate(ATTENDEE_ID, []).attendee,
      references: [
        {
          charge: fullyRefundedMoney(),
          kind: "observed",
          provider,
          reference,
        },
      ],
    },
  ],
  capability: "keyed",
  kind: "ready",
});

describe("refresh payment under an attendee claim", () => {
  test("records exact returned evidence without asking the provider to send", async () => {
    const reference = tagged("pi_returned", "stripe");
    const source = candidate(ATTENDEE_ID, [reference]);
    const provider = recordingProvider();
    const claim = grantingRowClaim(
      new Map([[ATTENDEE_ID, reference.rowSessionIds]]),
    );
    const marked: RefundPaymentReference[][] = [];
    const recorded: RefundPaymentReference[][] = [];
    const dependencies: RefreshPaymentDependencies = {
      claim,
      markReturned: (references) => {
        marked.push(references);
        return Promise.resolve();
      },
      paymentOnly: () => Promise.resolve(true),
      prepare: () => Promise.resolve(readyResult(reference, provider)),
      record: (_attendeeId, references) => {
        recorded.push(references);
        return Promise.resolve({ posted: true });
      },
    };

    expect(
      await refreshClaimedPayment(source, LISTING_ID, dependencies),
    ).toEqual({ kind: "returned", paymentOnly: true, posted: true });
    expect(provider.sends).toBe(0);
    expect(marked).toEqual([[reference]]);
    expect(recorded).toEqual([[reference]]);
    expect(claim.released).toEqual([reference.rowSessionIds]);
  });
});
