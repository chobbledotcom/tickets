import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PreparedReferenceRefund,
  type RefundProvider,
  refundCandidateAtProvider,
} from "#routes/admin/refunds/attempt.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "#routes/admin/refunds/provider-requests.ts";
import {
  candidate,
  candidateWithReferences,
  collectingMarker,
  completedRefund,
  provider,
  throwMarker,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoneyWith,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";

describe("admin refund provider", () => {
  const errors = setupErrorSpy();

  // The shared reporter decides how loudly each withheld result is said.
  for (const [name, read, outcome] of [
    ["could not be reached", () => Promise.resolve(null), "withheld"],
    [
      "says a refund is already on its way",
      () =>
        Promise.resolve(
          chargeMoneyWith({
            refunds: [refundObservation({ status: "pending" })],
          }),
        ),
      "pending",
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

      expect(quiet.refunds).toEqual([]);
      expect(marker.marked).toEqual([]);
      expect(result.outcome).toBe(outcome);
      expect(errors.calls).toHaveLength(0);
    });
  }

  test("reports an accepted refund as pending, not failed", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ accepted: new Set(["pi_pending"]) }),
      candidateWithReferences(["pi_pending"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("pending");
    expect(result.doubt).toBe("in_doubt");
    expect(marker.marked).toEqual([]);
    expect(errors.calls).toHaveLength(0);
  });

  test("does not report a multi-charge pending refund as an incident", async () => {
    const references = ["pi_pending_a", "pi_pending_b"];
    const result = await refundCandidateAtProvider(
      provider({ accepted: new Set(references) }),
      candidateWithReferences(references),
      7,
      collectingMarker().mark,
    );

    expect(result.outcome).toBe("pending");
    expect(errors.calls).toHaveLength(0);
  });

  for (const [state, blockedCharge] of [
    ["partly refunded", partlyRefundedCharge()],
    [
      "still settling",
      chargeMoneyWith({
        refunds: [refundObservation({ status: "pending" })],
      }),
    ],
  ] as const) {
    test(`moves no sibling money when one charge is ${state}`, async () => {
      const marker = collectingMarker();
      const cleanReferences = Array.from(
        { length: PROVIDER_REFUND_CONCURRENCY },
        (_, index) => `pi_clean_${index}`,
      );
      const references = [...cleanReferences, "pi_blocked"];
      const source = provider({
        read: (reference) =>
          Promise.resolve(
            reference === "pi_blocked" ? blockedCharge : chargeMoneyWith(),
          ),
        refunded: new Set(cleanReferences),
      });

      const result = await refundCandidateAtProvider(
        source,
        candidateWithReferences(references),
        7,
        marker.mark,
      );

      expect(source.reads.sort()).toEqual(references.sort());
      expect(source.refunds).toEqual([]);
      expect(marker.marked).toEqual([]);
      expect(result.outcome).toBe(
        state === "still settling" ? "pending" : "withheld",
      );
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
      "Admin refund rejected for attendee 42, payment pi_no",
    );
  });

  test("withholds when the provider proves no refund request was sent", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      {
        readCharge: () =>
          Promise.resolve({ resource: chargeMoneyWith(), status: "found" }),
        refundCapability: "keyed",
        refundCharge: () =>
          Promise.resolve({
            kind: "not_sent",
            reason: "not_configured",
          }),
      },
      candidateWithReferences(["pi_not_sent"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("withheld");
    expect(result.doubt).toBeUndefined();
    expect(marker.marked).toEqual([]);
    expect(errors.calls).toHaveLength(0);
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
    const references = Array.from({ length: 7 }, (_, index) => `pi_${index}`);
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

  test("keeps provider writes inside the concurrency limit", async () => {
    const references = Array.from({ length: 7 }, (_, index) => `pi_${index}`);
    const firstWaveStarted = Promise.withResolvers<void>();
    const releaseFirstWave = Promise.withResolvers<void>();
    let active = 0;
    let mostActive = 0;
    const source: RefundProvider = {
      readCharge: () =>
        Promise.resolve({ resource: chargeMoneyWith(), status: "found" }),
      refundCapability: "keyed",
      refundCharge: async (request) => {
        active += 1;
        mostActive = Math.max(mostActive, active);
        if (active === PROVIDER_REFUND_CONCURRENCY) {
          firstWaveStarted.resolve();
        }
        await releaseFirstWave.promise;
        active -= 1;
        return completedRefund(request);
      },
    };

    const refund = refundCandidateAtProvider(
      source,
      candidateWithReferences(references),
      7,
      collectingMarker().mark,
    );
    await firstWaveStarted.promise;
    releaseFirstWave.resolve();

    expect((await refund).outcome).toBe("refunded");
    expect(mostActive).toBe(PROVIDER_REFUND_CONCURRENCY);
  });

  test("reads and refunds a shared reference once across attendees", async () => {
    const source = provider({ refunded: new Set(["pi_shared"]) });
    const prepared = new Map<string, Promise<PreparedReferenceRefund>>();

    const results = await Promise.all(
      [11, 12].map((attendeeId) =>
        refundCandidateAtProvider(
          source,
          candidate([{ reference: "pi_shared" }], attendeeId),
          7,
          () => Promise.resolve(),
          new Set(),
          prepared,
        ),
      ),
    );

    expect(source.reads).toEqual(["pi_shared"]);
    expect(source.refunds).toEqual(["pi_shared"]);
    expect(results.map(({ outcome }) => outcome)).toEqual([
      "refunded",
      "refunded",
    ]);
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
