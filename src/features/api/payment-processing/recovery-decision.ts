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
 * reservation is impossible after atomic create cleanup, so it fails loudly.
 * For a STAGED session the token attendee is the staged row itself, so this
 * always rethrows — which is correct: the deterministic staged problems
 * (changed lines, already-active rows) return structured results before
 * anything can throw, so only transient or system-down errors reach here, and
 * those must retry on the provider's next delivery, never refund. */
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
