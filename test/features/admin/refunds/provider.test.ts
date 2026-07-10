import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  combineRefundOutcomes,
  packByReferenceCount,
  refundCandidateAtProvider,
} from "#routes/admin/refunds/provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

type Ref = { reference: string; providerRefunded?: boolean };

const candidate = (references: Ref[], id = 42): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, providerRefunded = false }) => ({
    providerRefunded,
    reference,
    sessionIds: [`sess_${reference}`],
  })),
});

const candidateWithReferences = (references: string[]): RefundCandidate =>
  candidate(references.map((reference) => ({ reference })));

/** Provider that refunds exactly the references in `refunded`, reports the
 * ones in `alreadyRefunded` as refunded on the follow-up check, and throws for
 * references in `throws`. */
const provider = ({
  refunded = new Set<string>(),
  alreadyRefunded = new Set<string>(),
  throws = new Set<string>(),
}: {
  refunded?: Set<string>;
  alreadyRefunded?: Set<string>;
  throws?: Set<string>;
} = {}) => ({
  isPaymentRefunded: (reference: string) =>
    Promise.resolve(alreadyRefunded.has(reference)),
  refundPayment: (reference: string) => {
    if (throws.has(reference)) throw new Error(`boom ${reference}`);
    return Promise.resolve(refunded.has(reference));
  },
});

const collectingMarker = () => {
  const marked: string[] = [];
  return {
    mark: (references: readonly RefundPaymentReference[]) => {
      marked.push(...references.map((reference) => reference.reference));
      return Promise.resolve();
    },
    marked,
  };
};

const throwMarker = () => {
  throw new Error("marker write failed");
};

const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, i) => ({ reference: `${id}${i}` })),
  );

describe("packByReferenceCount", () => {
  test("packs candidates into waves that stay within the budget", () => {
    const a = refs("a", 2);
    const b = refs("b", 1);
    const c = refs("c", 2);

    // budget 3: a(2)+b(1)=3 fits, c(2) would overflow → new wave.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b], [c]]);
  });

  test("adds the running count to the incoming size rather than multiplying it", () => {
    const a = refs("a", 1);
    const b = refs("b", 3);

    // budget 3: 1+3=4 > 3 → new wave; a multiplying mutant would see 1*3=3
    // and wrongly keep them together.
    expect(packByReferenceCount(3)([a, b])).toEqual([[a], [b]]);
  });

  test("resets the running count when a new wave starts", () => {
    const a = refs("a", 2);
    const b = refs("b", 2);
    const c = refs("c", 1);

    // budget 3: a→[a] (cc=2); b overflows→[b] (cc reset to 2); c 2+1=3 fits.
    // An accumulating mutant would carry cc past the reset and split c off.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a], [b, c]]);
  });

  test("increases the running count when appending to a wave", () => {
    const a = refs("a", 1);
    const b = refs("b", 1);
    const c = refs("c", 2);

    // budget 3: a,b append (cc=2); c 2+2=4 > 3 → new wave. A mutant that
    // fails to grow cc on append would keep c in the first wave.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b], [c]]);
  });

  test("keeps candidates together while the count stays at the budget", () => {
    const a = refs("a", 1);
    const b = refs("b", 1);
    const c = refs("c", 1);

    // budget 3: 1+1+1=3, never exceeds → single wave.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b, c]]);
  });

  test("gives an over-budget candidate its own wave", () => {
    const big = refs("x", 3);
    const small = refs("y", 1);

    expect(packByReferenceCount(2)([big, small])).toEqual([[big], [small]]);
  });

  test("returns no waves for an empty candidate list", () => {
    expect(packByReferenceCount(3)([])).toEqual([]);
  });
});

describe("combineRefundOutcomes", () => {
  test("prefers errored over every other outcome", () => {
    expect(combineRefundOutcomes(["refunded", "failed", "errored"])).toBe(
      "errored",
    );
  });

  test("prefers failed over refunded when nothing errored", () => {
    expect(combineRefundOutcomes(["refunded", "failed"])).toBe("failed");
  });

  test("is refunded only when every outcome is refunded", () => {
    expect(combineRefundOutcomes(["refunded", "refunded"])).toBe("refunded");
  });

  test("is refunded for an empty outcome list", () => {
    expect(combineRefundOutcomes([])).toBe("refunded");
  });
});

describe("admin refund provider", () => {
  const errors = setupErrorSpy();
  const loggedContains = (needle: string): boolean =>
    errors.calls.some((call) => String(call.args[0]).includes(needle));

  test("counts a reference already marked refunded without calling the provider", async () => {
    let refundCalls = 0;
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      {
        isPaymentRefunded: () => Promise.resolve(false),
        refundPayment: () => {
          refundCalls++;
          return Promise.resolve(false);
        },
      },
      candidate([{ providerRefunded: true, reference: "pi_pre" }]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("refunded");
    expect(refundCalls).toBe(0);
    expect(marker.marked).toEqual(["pi_pre"]);
  });

  test("refunds a reference the provider actively refunds", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(["pi_now"]) }),
      candidateWithReferences(["pi_now"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("refunded");
    expect(marker.marked).toEqual(["pi_now"]);
  });

  test("treats a reference the provider reports already refunded as refunded", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ alreadyRefunded: new Set(["pi_seen"]) }),
      candidateWithReferences(["pi_seen"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("refunded");
    expect(marker.marked).toEqual(["pi_seen"]);
  });

  test("fails and logs when the provider neither refunds nor confirms", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider(),
      candidateWithReferences(["pi_no"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("failed");
    expect(marker.marked).toEqual([]);
    expect(errors.lastMessage()).toContain(
      "Admin refund failed for attendee 42, payment pi_no",
    );
  });

  test("errors and logs when the provider throws", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ throws: new Set(["pi_boom"]) }),
      candidateWithReferences(["pi_boom"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("errored");
    expect(marker.marked).toEqual([]);
    expect(errors.lastMessage()).toContain(
      "Admin refund errored for attendee 42, payment pi_boom",
    );
  });

  test("marks only the refunded references of a partial refund", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(["pi_ok"]) }),
      candidateWithReferences(["pi_ok", "pi_bad"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("failed");
    expect(marker.marked).toEqual(["pi_ok"]);
    // A multi-reference candidate that did not fully refund is logged.
    expect(
      loggedContains(
        "Admin refund did not complete every payment for attendee 42",
      ),
    ).toBe(true);
  });

  test("does not log the incomplete-payment warning for a single reference", async () => {
    const result = await refundCandidateAtProvider(
      provider(),
      candidateWithReferences(["pi_solo"]),
      7,
      collectingMarker().mark,
    );

    expect(result.outcome).toBe("failed");
    expect(
      loggedContains(
        "Admin refund did not complete every payment for attendee 42",
      ),
    ).toBe(false);
  });

  test("refunds every reference across concurrency chunks", async () => {
    const references = Array.from({ length: 7 }, (_, i) => `pi_${i}`);
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(references) }),
      candidateWithReferences(references),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("refunded");
    expect(marker.marked.sort()).toEqual([...references].sort());
  });

  test("does not log the incomplete-payment warning when every reference refunds", async () => {
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(["pi_a", "pi_b"]) }),
      candidateWithReferences(["pi_a", "pi_b"]),
      7,
      collectingMarker().mark,
    );

    expect(result.outcome).toBe("refunded");
    expect(
      loggedContains(
        "Admin refund did not complete every payment for attendee 42",
      ),
    ).toBe(false);
  });

  test("keeps a successful provider refund successful when recording the marker fails", async () => {
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(["pi_done"]) }),
      candidateWithReferences(["pi_done"]),
      7,
      throwMarker,
    );

    expect(result.outcome).toBe("refunded");
    expect(errors.lastMessage()).toContain(
      "could not record returned payments for attendee 42",
    );
  });

  test("treats a partial provider refund as errored when recording the marker fails", async () => {
    const result = await refundCandidateAtProvider(
      provider({ refunded: new Set(["pi_done"]) }),
      candidateWithReferences(["pi_done", "pi_failed"]),
      7,
      throwMarker,
    );

    expect(result.outcome).toBe("errored");
    expect(errors.lastMessage()).toContain(
      "could not record returned payments for attendee 42",
    );
  });
});
