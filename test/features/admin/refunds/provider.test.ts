import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  processRefundBatch,
  type RowClaim,
  refundCandidateAtProvider,
  underAttendeeClaim,
} from "#routes/admin/refunds/provider.ts";
import {
  combineRefundOutcomes,
  packByReferenceCount,
} from "#routes/admin/refunds/waves.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type Ref = { reference: string; refundState?: RefundState };

const candidate = (references: Ref[], id = 42): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, refundState = "none" }) => ({
    reference,
    refundState,
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
  readChargeMoneyOrNull: (reference: string) =>
    Promise.resolve(
      alreadyRefunded.has(reference) ? fullyRefundedMoney() : chargeMoney(),
    ),
  refundCapability: "keyed" as const,
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

/** Three candidates named a, b, c with the given reference counts. */
const threeCandidates = (na: number, nb: number, nc: number) =>
  [refs("a", na), refs("b", nb), refs("c", nc)] as const;

describe("packByReferenceCount", () => {
  test("packs candidates into waves that stay within the budget", () => {
    const [a, b, c] = threeCandidates(2, 1, 2);

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
    const [a, b, c] = threeCandidates(2, 2, 1);

    // budget 3: a→[a] (cc=2); b overflows→[b] (cc reset to 2); c 2+1=3 fits.
    // An accumulating mutant would carry cc past the reset and split c off.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a], [b, c]]);
  });

  test("increases the running count when appending to a wave", () => {
    const [a, b, c] = threeCandidates(1, 1, 2);

    // budget 3: a,b append (cc=2); c 2+2=4 > 3 → new wave. A mutant that
    // fails to grow cc on append would keep c in the first wave.
    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b], [c]]);
  });

  test("keeps candidates together while the count stays at the budget", () => {
    const [a, b, c] = threeCandidates(1, 1, 1);

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

  test("counts a reference already marked refunded without calling the provider", async () => {
    let refundCalls = 0;
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      {
        readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
        refundCapability: "keyed" as const,
        refundPayment: () => {
          refundCalls++;
          return Promise.resolve(false);
        },
      },
      candidate([{ reference: "pi_pre", refundState: "completed" }]),
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
      errors.contains(
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
      errors.contains(
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
      errors.contains(
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

describe("admin refund provider > the claim", () => {
  /** A claim that refuses, as if another run already held these attendees. */
  const blockedRowClaim = (): RowClaim => ({
    claim: () =>
      Promise.resolve({ blockedBy: { kind: "held" }, kind: "blocked" }),
    release: () => Promise.resolve(),
  });

  const countingProvider = (calls: { count: number }) => ({
    readChargeMoneyOrNull: () => {
      calls.count++;
      return Promise.resolve(chargeMoney());
    },
    refundCapability: "keyless" as const,
    refundPayment: () => {
      calls.count++;
      return Promise.resolve(true);
    },
  });

  test("a blocked run never asks the provider anything", async () => {
    const calls = { count: 0 };
    const counts = await processRefundBatch(
      countingProvider(calls),
      [candidate([{ reference: "pi_held", refundState: "none" }])],
      7,
      blockedRowClaim(),
    );

    expect(counts).toEqual({ errorCount: 0, failedCount: 1, refundedCount: 0 });
    expect(calls.count).toBe(0);
  });

  test("the whole batch is held by one claim, not one per attendee", async () => {
    const rowClaim = grantingRowClaim();
    const claimed: number[][] = [];
    const counting: RowClaim = {
      claim: (attendeeIds, capability) => {
        claimed.push([...attendeeIds]);
        return rowClaim.claim(attendeeIds, capability);
      },
      release: rowClaim.release,
    };

    await processRefundBatch(
      provider({ refunded: new Set(["pi_1", "pi_2", "pi_3"]) }),
      [
        candidate([{ reference: "pi_1", refundState: "none" }], 11),
        candidate([{ reference: "pi_2", refundState: "none" }], 12),
        candidate([{ reference: "pi_3", refundState: "none" }], 13),
      ],
      7,
      counting,
    );

    // Three attendees, one hold — a bulk wave costs the same round trips as a
    // single refund, which is what the subrequest allowance is sized for.
    expect(claimed).toEqual([[11, 12, 13]]);
    expect(rowClaim.released).toHaveLength(1);
  });

  test("a keyless batch whose call errored keeps its claim standing", async () => {
    const rowClaim = grantingRowClaim();
    const keylessThatDies = {
      readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
      refundCapability: "keyless" as const,
      refundPayment: (): Promise<boolean> => {
        throw new Error("the answer never came back");
      },
    };

    await processRefundBatch(
      keylessThatDies,
      [candidate([{ reference: "pi_lost", refundState: "none" }])],
      7,
      rowClaim,
    );

    // The money may already have gone; without an idempotency key nothing may
    // try again until fresh evidence says what happened.
    expect(rowClaim.released).toHaveLength(0);
  });
});

describe("admin refund provider > an unrecorded refund", () => {
  const keyless = {
    readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
    refundCapability: "keyless" as const,
    refundPayment: () => Promise.resolve(true),
  };

  test("a refund the provider did not confirm is unsettled", async () => {
    const keylessSaysNo = {
      readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
      refundCapability: "keyless" as const,
      refundPayment: () => Promise.resolve(false),
    };

    const result = await refundCandidateAtProvider(
      keylessSaysNo,
      candidateWithReferences(["pi_unanswered"]),
      7,
      () => Promise.resolve(),
    );

    // A lost answer looks exactly like a refusal from here, so the run must
    // keep its hold rather than let a retry send the money again.
    expect(result.outcome).toBe("failed");
    expect(result.unsettled).toBe(true);
  });

  test("a refund never sent is settled — nothing was asked for", async () => {
    const alreadyBack = {
      readChargeMoneyOrNull: () => Promise.resolve(fullyRefundedMoney()),
      refundCapability: "keyless" as const,
      refundPayment: () => Promise.resolve(true),
    };

    const result = await refundCandidateAtProvider(
      alreadyBack,
      candidateWithReferences(["pi_already"]),
      7,
      () => Promise.resolve(),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.unsettled).toBeUndefined();
  });

  test("a refund whose returned-marker write fails is reported unsettled", async () => {
    const result = await refundCandidateAtProvider(
      keyless,
      candidateWithReferences(["pi_unrecorded"]),
      7,
      () => Promise.reject(new Error("the marker could not be written")),
    );

    // The money went back, so it still counts as refunded...
    expect(result.outcome).toBe("refunded");
    // ...but nothing durable says so.
    expect(result.unsettled).toBe(true);
  });

  test("a refund whose marker write succeeds is settled", async () => {
    const result = await refundCandidateAtProvider(
      keyless,
      candidateWithReferences(["pi_recorded"]),
      7,
      () => Promise.resolve(),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.unsettled).toBeUndefined();
  });

  /** Run a keyless hold whose work ends recorded or not, and say how many
   *  times it let go. */
  const releasesAfter = async (unsettled: boolean): Promise<number> => {
    const rowClaim = grantingRowClaim();
    await underAttendeeClaim(rowClaim, [11], "keyless", 7, {
      blocked: () => ({ unsettled: false }),
      lost: (result) => result.unsettled,
      work: () => Promise.resolve({ unsettled }),
    });
    return rowClaim.released.length;
  };

  test("a keyless run keeps its hold when the answer is unrecorded", async () => {
    // Releasing here is how a retry, reading a provider that has not caught
    // up, sends the money a second time.
    expect(await releasesAfter(true)).toBe(0);
  });

  test("a keyless run lets go when the answer is recorded", async () => {
    expect(await releasesAfter(false)).toBe(1);
  });
});
