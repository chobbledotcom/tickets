export type RecoveryFacts = {
  finalizedAttendeeId: number | null;
  tokenAttendeeId: number | null;
  unresolved: boolean;
};

export type RecoveryDecision =
  | { attendeeId: number; kind: "recover" }
  | { kind: "rethrow" }
  | { kind: "retry" };

/**
 * Decide from committed primary state only. Recovery is safe only when the
 * finalized payment and the prepared ticket token identify the same attendee.
 * `retry` means the batch provably rolled back: no attendee, no finalize — the
 * provider's redelivery can try the whole booking again once the reservation
 * is released.
 */
export const decideUnexpectedCreate = (
  facts: RecoveryFacts,
): RecoveryDecision => {
  if (
    facts.finalizedAttendeeId !== null &&
    facts.finalizedAttendeeId === facts.tokenAttendeeId &&
    !facts.unresolved
  ) {
    return { attendeeId: facts.finalizedAttendeeId, kind: "recover" };
  }
  if (
    facts.finalizedAttendeeId !== null ||
    !facts.unresolved ||
    facts.tokenAttendeeId !== null
  ) {
    return { kind: "rethrow" };
  }
  return { kind: "retry" };
};
