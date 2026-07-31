import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { takeRefundWave } from "#routes/admin/refunds/waves.ts";

type Ref = { reference: string; providerRefunded?: boolean };

const candidate = (references: Ref[], id = 42): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, providerRefunded = false }) => ({
    providerRefunded,
    reference,
    sessionIds: [`sess_${reference}`],
  })),
  targets: [],
});

const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, i) => ({ reference: `${id}${i}` })),
  );

/** Three candidates named a, b, c with the given reference counts. */
const threeCandidates = (na: number, nb: number, nc: number) =>
  [refs("a", na), refs("b", nb), refs("c", nc)] as const;

describe("takeRefundWave", () => {
  test("takes the leading candidates that stay within the budget", () => {
    const [a, b, c] = threeCandidates(2, 1, 2);

    expect(takeRefundWave(3)([a, b, c])).toEqual([a, b]);
  });

  test("adds the running count to the incoming size", () => {
    const a = refs("a", 1);
    const b = refs("b", 3);

    expect(takeRefundWave(3)([a, b])).toEqual([a]);
  });

  test("takes candidates while the count equals the budget", () => {
    const [a, b, c] = threeCandidates(1, 1, 1);

    expect(takeRefundWave(3)([a, b, c])).toEqual([a, b, c]);
  });

  test("leaves an over-budget first candidate for background work", () => {
    const big = refs("x", 3);
    const small = refs("y", 1);

    expect(takeRefundWave(2)([big, small])).toEqual([]);
  });

  test("returns no candidates for an empty list", () => {
    expect(takeRefundWave(3)([])).toEqual([]);
  });
});
