import type {
  MarkReturnedReferences,
  RefundProvider,
} from "#routes/admin/refunds/attempt.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type {
  RefundBatchResult,
  RefundCounts,
} from "#routes/admin/refunds/provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { sessionReference } from "#test/shared/refund-ledger/helpers.ts";
import {
  acceptedRefund,
  chargeMoney,
  fullyRefundedMoney,
  refundReference,
} from "#test-utils/payment-state.ts";

type Reference = { reference: string; refundState?: RefundState };

type RecordingProvider = RefundProvider & {
  reads: string[];
  refunds: string[];
};

type UnreadableProvider = RefundProvider & { sent: string[] };

type Marker = {
  mark: MarkReturnedReferences;
  marked: string[];
};

export const finishedCounts = (result: RefundBatchResult): RefundCounts => {
  if (result.kind === "blocked") {
    throw new Error(`Expected the refund batch to run (${result.reason})`);
  }
  return result.counts;
};

export const oneFailedRefundCounts: RefundCounts = {
  errorCount: 0,
  failedCount: 1,
  notRecordedCount: 0,
  pendingCount: 0,
  refundedCount: 0,
};

export const candidate = (
  references: Reference[],
  id = 42,
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, refundState = "none" }) =>
    refundReference(reference, { refundState }),
  ),
});

export const candidateWithReferences = (
  references: string[],
): RefundCandidate => candidate(references.map((reference) => ({ reference })));

export const completedRefund = (
  request: RefundRequest,
): Extract<RefundAttemptResult, { kind: "completed" }> => ({
  amount: request.charge.captured,
  kind: "completed",
  proof: { charge: request.charge, kind: "charge_observation" },
});

/** Unreadable provider that records anything it is asked to send. */
export const unreadableProvider = (
  refundCapability: RefundCapability,
): UnreadableProvider => {
  const sent: string[] = [];
  return {
    readCharge: () =>
      Promise.resolve({
        reason: "network_error",
        status: "unavailable",
      } as const),
    refundCapability,
    refundCharge: (request: RefundRequest) => {
      sent.push(request.paymentReference);
      return Promise.resolve(completedRefund(request));
    },
    sent,
  };
};

/** Provider that records every read and refund request. */
export const provider = ({
  accepted = new Set<string>(),
  refunded = new Set<string>(),
  alreadyRefunded = new Set<string>(),
  throws = new Set<string>(),
  refundCapability = "keyed" as RefundCapability,
  read,
}: {
  accepted?: Set<string>;
  refunded?: Set<string>;
  alreadyRefunded?: Set<string>;
  throws?: Set<string>;
  refundCapability?: RefundCapability;
  read?: (reference: string) => Promise<ChargeMoney | null>;
} = {}): RecordingProvider => {
  const reads: string[] = [];
  const refunds: string[] = [];
  return {
    readCharge: async (reference: string) => {
      reads.push(reference);
      try {
        const charge = read
          ? await read(reference)
          : alreadyRefunded.has(reference)
            ? fullyRefundedMoney()
            : chargeMoney();
        return charge === null
          ? ({ reason: "network_error", status: "unavailable" } as const)
          : ({ resource: charge, status: "found" } as const);
      } catch {
        return { reason: "network_error", status: "unavailable" } as const;
      }
    },
    reads,
    refundCapability,
    refundCharge: (request: RefundRequest) => {
      refunds.push(request.paymentReference);
      if (throws.has(request.paymentReference)) {
        return Promise.resolve<RefundAttemptResult>({
          kind: "uncertain",
          reason: "network_error",
        });
      }
      return Promise.resolve<RefundAttemptResult>(
        accepted.has(request.paymentReference)
          ? acceptedRefund(request.charge)
          : refunded.has(request.paymentReference)
            ? completedRefund(request)
            : { kind: "rejected", reason: "failed" },
      );
    },
    refunds,
  };
};

export const collectingMarker = (): Marker => {
  const marked: string[] = [];
  return {
    mark: (references: readonly RefundPaymentReference[]) => {
      marked.push(...references.map((reference) => reference.reference));
      return Promise.resolve();
    },
    marked,
  };
};

export const throwMarker = (): never => {
  throw new Error("marker write failed");
};

export const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, index) => ({
      reference: `${id}${index}`,
    })),
  );

export const holdingClaim = (
  release: RowClaim["release"],
  sessions: readonly string[],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      inherited: new Map(),
      kind: "claimed",
      returned: new Set<string>(),
    }),
  release,
});

export const refundedCandidate = (
  attendeeId: number,
  sessionId: string,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [sessionReference(sessionId)],
});

export const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) =>
    refundReference(reference, { sessionIds: [] }),
  ),
});

/** Provider that rejects each refund except named uncertain answers. */
export const failingProvider = (
  uncertain: Set<string>,
  refundCapability: RefundCapability = "keyed",
): RefundProvider => ({
  readCharge: () =>
    Promise.resolve({ resource: chargeMoney(), status: "found" } as const),
  refundCapability,
  refundCharge: ({ paymentReference }: RefundRequest) =>
    Promise.resolve<RefundAttemptResult>(
      uncertain.has(paymentReference)
        ? { kind: "uncertain", reason: "network_error" }
        : { kind: "rejected", reason: "failed" },
    ),
});
