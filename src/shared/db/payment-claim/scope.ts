import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
import type { ClaimDecision, ClaimRequest } from "#shared/payment/claim.ts";
import type { RefundClaim } from "#shared/payment/row-state.ts";

type ScopedPaymentRow = {
  readonly referenceIndex: string;
  readonly sessionId: string;
};

const sortedUniqueIds = (ids: readonly number[]): number[] =>
  [...new Set(ids)].sort((left, right) => left - right);

/** Names every initiating attendee whose loaded reference matches this row. */
export const claimRequestFor = (
  attendees: readonly LoadedRefundAttendee[],
  row: ScopedPaymentRow,
): ClaimRequest => {
  const attendeeIds = sortedUniqueIds(
    attendees.flatMap((attendee) =>
      attendee.references.some((reference) =>
        reference.matchingIndexes.includes(row.referenceIndex),
      )
        ? [attendee.attendeeId]
        : [],
    ),
  );
  if (attendeeIds.length === 0) {
    throw new Error("Payment row matched no initiating attendee");
  }
  return { attendeeIds, scope: "attendee_set" };
};

/** Stale pre-send work starts over; only a possibly sent command stays armed. */
export const nextClaimFor = (
  decision: ClaimDecision,
  request: ClaimRequest,
  commandId: string,
  writtenAt: string,
): RefundClaim => {
  const claim = {
    attendeeIds: [...request.attendeeIds],
    commandId,
    scope: request.scope,
    writtenAt,
  };
  return decision.kind === "resume" && decision.resuming.phase === "send_armed"
    ? {
        ...claim,
        capability: decision.resuming.capability,
        phase: "send_armed",
      }
    : { ...claim, phase: "checking" };
};
