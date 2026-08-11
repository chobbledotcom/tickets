import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  type AttendeeVerdict,
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
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  refundObservation,
  refundReference,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type Ref = { reference: string; refundState?: RefundState };

/** One attendee whose charge is already on a row, so nothing needs anchoring
 *  and no database is touched — these tests are about the hold, not minting. */
const holding = (...sessionIds: string[]) => [
  {
    attendeeId: 11,
    references: [
      refundReference("pi_held", {
        index: "index_of_held",
        rowSessionIds: sessionIds.length > 0 ? sessionIds : ["sess-held-row"],
        sessionIds,
      }),
    ],
  },
];

const candidate = (references: Ref[], id = 42): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, refundState = "none" }) =>
    refundReference(reference, { refundState }),
  ),
});

/** A claim that grants attendee 11 the rows it names — the attendee `holding`
 *  builds — and lets each test say what its release does. */
const holdingClaim = (
  release: RowClaim["release"],
  sessions: readonly string[] = ["sess-x"],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      kind: "claimed",
      returned: new Set<string>(),
    }),
  release,
});

const candidateWithReferences = (references: string[]): RefundCandidate =>
  candidate(references.map((reference) => ({ reference })));

/** Provider that refunds exactly the references in `refunded`, reports the
 * ones in `alreadyRefunded` as refunded on the follow-up check, and throws for
 * references in `throws`. `read` replaces the charge-money answer outright.
 * Records every reference it was asked about, so a test can say plainly which
 * calls were made — and that none was. */
const provider = ({
  refunded = new Set<string>(),
  alreadyRefunded = new Set<string>(),
  throws = new Set<string>(),
  refundCapability = "keyed" as RefundCapability,
  read,
}: {
  refunded?: Set<string>;
  alreadyRefunded?: Set<string>;
  throws?: Set<string>;
  refundCapability?: RefundCapability;
  read?: () => Promise<ChargeMoney | null>;
} = {}) => {
  const reads: string[] = [];
  const refunds: string[] = [];
  return {
    readChargeMoneyOrNull: (reference: string) => {
      reads.push(reference);
      if (read) return read();
      return Promise.resolve(
        alreadyRefunded.has(reference) ? fullyRefundedMoney() : chargeMoney(),
      );
    },
    reads,
    refundCapability,
    refundPayment: (reference: string) => {
      refunds.push(reference);
      if (throws.has(reference)) throw new Error(`boom ${reference}`);
      return Promise.resolve(refunded.has(reference));
    },
    refunds,
  };
};

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

  test("prefers failed over withheld — one asked and was turned down", () => {
    expect(combineRefundOutcomes(["withheld", "failed"])).toBe("failed");
  });

  test("prefers withheld over refunded — not every penny went back", () => {
    expect(combineRefundOutcomes(["refunded", "withheld"])).toBe("withheld");
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

  // A withheld refund is not automatically an incident. The shared reporter
  // decides how loudly each kind is said, and only a real disagreement gets
  // the classified fan-out — alerting on a provider outage or a refund already
  // settling would bury the ones that need somebody.
  for (const [name, read] of [
    ["could not be reached", () => Promise.resolve(null)],
    [
      "says a refund is already on its way",
      () =>
        Promise.resolve(
          chargeMoneyWith({
            refunds: [refundObservation({ status: "pending" })],
          }),
        ),
    ],
  ] as const) {
    test(`a provider that ${name} raises no incident`, async () => {
      const marker = collectingMarker();
      const quiet = provider({ read });
      const result = await refundCandidateAtProvider(
        quiet,
        candidate([{ reference: "pi_quiet" }]),
        7,
        marker.mark,
      );

      // What the test is actually about is that no money was asked for at all,
      // and "withheld" is what says so where "failed" could not.
      expect(quiet.refunds).toEqual([]);
      expect(marker.marked).toEqual([]);
      expect(result.outcome).toBe("withheld");
      expect(errors.calls).toHaveLength(0);
    });
  }

  test("counts a reference already marked refunded without calling the provider", async () => {
    const marker = collectingMarker();
    const untouched = provider();
    const result = await refundCandidateAtProvider(
      untouched,
      candidate([{ reference: "pi_pre", refundState: "completed" }]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("refunded");
    expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
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

  test("a blocked run never asks the provider anything", async () => {
    const untouched = provider({ refundCapability: "keyless" });
    const counts = await processRefundBatch(
      untouched,
      [candidate([{ reference: "pi_held", refundState: "none" }])],
      7,
      blockedRowClaim(),
    );

    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 1,
      notRecordedCount: 0,
      refundedCount: 0,
    });
    expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
  });

  test("the whole batch is held by one claim, not one per attendee", async () => {
    const rowClaim = grantingRowClaim(
      new Map([
        [11, ["sess_pi_1"]],
        [12, ["sess_pi_2"]],
        [13, ["sess_pi_3"]],
      ]),
    );
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
    const rowClaim = grantingRowClaim(new Map([[42, ["sess_pi_lost"]]]));
    const keylessThatDies = provider({
      refundCapability: "keyless",
      throws: new Set(["pi_lost"]),
    });

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
  const keyless = provider({
    refundCapability: "keyless",
    refunded: new Set(["pi_unrecorded", "pi_recorded"]),
  });

  test("a refund the provider did not confirm is unsettled", async () => {
    const keylessSaysNo = provider({ refundCapability: "keyless" });

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

  test("a reading the provider could not give leaves the hold free", async () => {
    const unreadable = provider({
      read: () => {
        throw new Error("the provider could not be reached");
      },
      refundCapability: "keyless",
    });

    const result = await refundCandidateAtProvider(
      unreadable,
      candidateWithReferences(["pi_unreadable"]),
      7,
      () => Promise.resolve(),
    );

    // No money was asked for, so there is nothing to be in doubt about and a
    // retry in a moment is free. "withheld" says that where "failed" could not:
    // nothing was sent, rather than something sent and refused.
    expect(result.outcome).toBe("withheld");
    expect(result.unsettled).toBeUndefined();
  });

  test("a refund never sent is settled — nothing was asked for", async () => {
    const alreadyBack = provider({
      alreadyRefunded: new Set(["pi_already"]),
      refundCapability: "keyless",
    });

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
  /** Run a keyless hold on one attendee and report what it let go of, and what
   *  it marked as money the ledger has not caught up with. */
  const keylessHold = async (verdict?: AttendeeVerdict) => {
    const rowClaim = grantingRowClaim(new Map([[11, ["sess-held"]]]));
    await underAttendeeClaim(rowClaim, holding("sess-held"), "keyless", 7, {
      blocked: () => "blocked",
      verdicts: () => (verdict ? new Map([[11, verdict]]) : new Map()),
      work: () => Promise.resolve("ran"),
    });
    return rowClaim;
  };

  test("a keyless run keeps its hold while the answer is in doubt", async () => {
    // Releasing here is how a retry, reading a provider that has not caught
    // up, sends the money a second time.
    expect((await keylessHold("in_doubt")).released).toEqual([]);
  });

  test("a keyless run lets go when the answer is settled", async () => {
    expect((await keylessHold()).released).toEqual([["sess-held"]]);
  });

  test("a keyless run whose money the ledger missed lets go, marked", async () => {
    // The provider answered clearly, so there is no doubt to hold against —
    // only books that are behind. Keeping the claim here is what left a SumUp
    // attendee un-pickable, un-deletable and un-mergeable for good; the mark
    // protects the row the correction needs without any of that.
    const rowClaim = await keylessHold("unrecorded");

    expect(rowClaim.released).toEqual([["sess-held"]]);
    expect(rowClaim.unrecorded).toEqual([["sess-held"]]);
  });
});

describe("admin refund provider > a reference already sent back", () => {
  test("is not refunded again, whatever the loaded snapshot said", async () => {
    const untouched = provider({ refundCapability: "keyless" });

    // The snapshot says this still needs refunding; the claim says otherwise.
    const result = await refundCandidateAtProvider(
      untouched,
      candidateWithReferences(["pi_raced"]),
      7,
      () => Promise.resolve(),
      new Set([refundReference("pi_raced").index]),
    );

    expect(result.outcome).toBe("refunded");
    expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
  });
});

describe("admin refund provider > a release that fails", () => {
  const errors = setupErrorSpy();

  test("reports it and leaves the run's answer alone", async () => {
    const refusingRelease = holdingClaim(() =>
      Promise.reject(new Error("the row would not let go")),
    );

    const result = await underAttendeeClaim(
      refusingRelease,
      holding("sess-x"),
      "keyed",
      7,
      {
        blocked: () => ({ tally: "blocked" }),
        verdicts: () => new Map(),
        work: () => Promise.resolve({ tally: "refunded" }),
      },
    );

    // The hold goes stale by itself; the answer does not come back.
    expect(result).toEqual({ tally: "refunded" });
    expect(errors.contains("Refund claim could not be released")).toBe(true);
  });
});

describe("admin refund provider > a payment that landed while we waited", () => {
  test("a merge anchor is not mistaken for one", async () => {
    // The reference list leaves a merge anchor's id out on purpose.
    const holdsAnchor = holdingClaim(
      () => Promise.resolve(),
      ["sess-known", "legacy-merge:7"],
    );

    const result = await underAttendeeClaim(
      holdsAnchor,
      holding("sess-known"),
      "keyless",
      7,
      {
        blocked: (reason) => reason,
        verdicts: () => new Map(),
        work: () => Promise.resolve("ran"),
      },
    );

    expect(result).toBe("ran");
  });

  test("stands the whole run down rather than refunding part of it", async () => {
    const released: string[][] = [];
    // The hold covers a row this run never loaded.
    const holdsMore = holdingClaim(
      ({ sessionIds }) => {
        released.push([...sessionIds]);
        return Promise.resolve();
      },
      ["sess-known", "sess-new"],
    );

    let worked = false;
    const result = await underAttendeeClaim(
      holdsMore,
      holding("sess-known"),
      "keyless",
      7,
      {
        blocked: (reason) => reason,
        verdicts: () => new Map(),
        work: () => {
          worked = true;
          return Promise.resolve("ran");
        },
      },
    );

    // Refunding what we loaded would return part of the money and leave the
    // rest, so nothing runs and the hold goes back.
    expect(worked).toBe(false);
    expect(result).toContain("landed while this run was waiting");
    expect(released).toEqual([["sess-known", "sess-new"]]);
  });
});

describe("admin refund provider > one charge two attendees carry", () => {
  test("is asked about once in a run, not once per attendee", async () => {
    const shared = provider({
      refundCapability: "keyless",
      refunded: new Set(["pi_both"]),
    });

    const counts = await processRefundBatch(
      shared,
      [
        candidate([{ reference: "pi_both", refundState: "none" }], 11),
        candidate([{ reference: "pi_both", refundState: "none" }], 12),
      ],
      7,
      grantingRowClaim(),
      () => Promise.resolve(),
    );

    // The hold cannot separate these two: both rows belong to this same run.
    // Only asking once does.
    expect(shared.refunds).toEqual(["pi_both"]);
    // Neither attendee was refused: both took the answer from that one call.
    // They then both fail to post, because these two exist only in the
    // candidates above and have no account to reverse — so the money moving
    // shows up as a missing ledger record apiece rather than as a refund
    // apiece. It is counted apart from an uncertain provider, since this one
    // answered and the money really did go back.
    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 0,
      notRecordedCount: 2,
      refundedCount: 0,
    });
  });
});

describe("admin refund provider > a run that dies holding money", () => {
  test("lets the hold go and raises the failure, rather than swallowing it", async () => {
    const releases: string[] = [];
    const recordsRelease = holdingClaim(() => {
      releases.push("released");
      return Promise.resolve();
    });

    await expect(
      underAttendeeClaim(recordsRelease, holding("sess-x"), "keyed", 7, {
        blocked: () => "blocked",
        verdicts: () => new Map(),
        work: () => Promise.reject(new Error("the provider fell over")),
      }),
    ).rejects.toThrow("the provider fell over");

    // A run that died never learned what the money did, so its hold is judged
    // as a lost answer. A keyed provider is safe to re-run onto the same key,
    // so the hold goes rather than standing until it goes stale.
    expect(releases).toEqual(["released"]);
  });
});
