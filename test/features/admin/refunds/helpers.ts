import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";

type Ref = { reference: string; providerRefunded?: boolean };

export const candidate = (references: Ref[], id = 42): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, providerRefunded = false }) => ({
    providerRefunded,
    reference,
    sessionIds: [`sess_${reference}`],
  })),
});

export const candidateWithReferences = (
  references: string[],
): RefundCandidate => candidate(references.map((reference) => ({ reference })));

export const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, i) => ({ reference: `${id}${i}` })),
  );

/** Three candidates named a, b, c with the given reference counts. */
export const threeCandidates = (
  na: number,
  nb: number,
  nc: number,
): readonly [RefundCandidate, RefundCandidate, RefundCandidate] =>
  [refs("a", na), refs("b", nb), refs("c", nc)] as const;
