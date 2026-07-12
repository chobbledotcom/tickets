export type RecoveryFacts = {
  finalizedAttendeeId: number | null;
  tokenAttendeeId: number | null;
  unresolved: boolean;
};

export type RecoveryDecision =
  | { attendeeId: number; kind: "recover" }
  | { kind: "refund" }
  | { kind: "rethrow" };

/** Decide from committed primary state only. An attendee beside an unresolved
 * reservation is impossible after atomic create cleanup, so it fails loudly. */
export const decideUnexpectedCreate = (
  facts: RecoveryFacts,
): RecoveryDecision => {
  if (facts.finalizedAttendeeId !== null) {
    return { attendeeId: facts.finalizedAttendeeId, kind: "recover" };
  }
  if (!facts.unresolved || facts.tokenAttendeeId !== null) {
    return { kind: "rethrow" };
  }
  return { kind: "refund" };
};
