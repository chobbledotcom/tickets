import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PreparedReferenceRefund,
  refundReadyCandidate,
} from "#routes/admin/refunds/attempt.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "#routes/admin/refunds/provider-requests.ts";
import { authorizeEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  collectingMarker,
  completedRefund,
  provider,
  readyCandidate,
  readyCandidateWithReferences,
  throwMarker,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";

describe("admin refund provider", () => {
  const errors = setupErrorSpy();

  test("sends the exact charge readiness already observed", async () => {
    const source = provider({ refunded: new Set(["pi_exact"]) });
    const observed = chargeMoney(731, 0, "GBP");
    const marker = collectingMarker();

    const result = await refundReadyCandidate(
      readyCandidate([{ charge: observed, reference: "pi_exact" }], source),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(source.reads).toEqual([]);
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.charge).toBe(observed);
    expect(result.outcome).toBe("refunded");
    expect(marker.marked).toEqual(["pi_exact"]);
    expect(result.returned[0]).toMatchObject({
      kind: "tagged",
      provider: "stripe",
      reference: "pi_exact",
    });
  });

  test("reports an accepted refund as pending, not failed", async () => {
    const source = provider({ accepted: new Set(["pi_pending"]) });
    const marker = collectingMarker();

    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_pending"], source),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("pending");
    expect(result.doubt).toBe("in_doubt");
    expect(marker.marked).toEqual([]);
    expect(errors.calls).toHaveLength(0);
  });

  for (const [state, blockedCharge, outcome] of [
    ["partly refunded", partlyRefundedCharge(), "withheld"],
    [
      "still settling",
      chargeMoneyWith({
        refunds: [refundObservation({ status: "pending" })],
      }),
      "pending",
    ],
  ] as const) {
    test(`moves no sibling money when one charge is ${state}`, async () => {
      const source = provider({
        refunded: new Set(["pi_clean_a", "pi_clean_b"]),
      });
      const marker = collectingMarker();
      const result = await refundReadyCandidate(
        readyCandidate(
          [
            { reference: "pi_clean_a" },
            { charge: blockedCharge, reference: "pi_blocked" },
            { reference: "pi_clean_b" },
          ],
          source,
        ),
        7,
        marker.mark,
        authorizeEveryRefund(),
      );

      expect(source.refunds).toEqual([]);
      expect(marker.marked).toEqual([]);
      expect(result.outcome).toBe(outcome);
    });
  }

  test("answers an already-returned reference without provider IO", async () => {
    const source = provider();
    const marker = collectingMarker();
    const result = await refundReadyCandidate(
      readyCandidate(
        [{ kind: "already_returned", reference: "pi_pre" }],
        source,
      ),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect([...source.reads, ...source.refunds]).toEqual([]);
    expect(result.outcome).toBe("refunded");
    expect(marker.marked).toEqual(["pi_pre"]);
  });

  test("does not send when the exact observation says money is back", async () => {
    const source = provider();
    const marker = collectingMarker();
    const result = await refundReadyCandidate(
      readyCandidate(
        [{ charge: fullyRefundedMoney(), reference: "pi_seen" }],
        source,
      ),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(source.refunds).toEqual([]);
    expect(result.outcome).toBe("refunded");
    expect(marker.marked).toEqual(["pi_seen"]);
  });

  test("fails and logs when the provider rejects the refund", async () => {
    const source = provider();
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_no"], source),
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("failed");
    expect(errors.lastMessage()).toContain(
      "Admin refund rejected for attendee 42, payment pi_no",
    );
  });

  test("withholds when the provider proves no refund request was sent", async () => {
    const source = provider({
      refund: () =>
        Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
    });
    const marker = collectingMarker();
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_not_sent"], source),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("withheld");
    expect(result.doubt).toBeUndefined();
    expect(marker.marked).toEqual([]);
    expect(errors.calls).toHaveLength(0);
  });

  test("errors and logs when the provider answer is uncertain", async () => {
    const source = provider({ throws: new Set(["pi_boom"]) });
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_boom"], source),
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("errored");
    expect(errors.lastMessage()).toContain(
      "Admin refund errored for attendee 42, payment pi_boom",
    );
  });

  test("marks only the references whose provider refund completed", async () => {
    const source = provider({ refunded: new Set(["pi_ok"]) });
    const marker = collectingMarker();
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_ok", "pi_bad"], source),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("failed");
    expect(marker.marked).toEqual(["pi_ok"]);
    expect(
      errors.contains(
        "Admin refund did not complete every payment for attendee 42",
      ),
    ).toBe(true);
  });

  test("does not log an incomplete-payment warning for one reference", async () => {
    const source = provider();
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_solo"], source),
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
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
    const source = provider({ refunded: new Set(references) });
    const marker = collectingMarker();
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(references, source),
      7,
      marker.mark,
      authorizeEveryRefund(),
    );

    expect(result.outcome).toBe("refunded");
    expect(marker.marked.sort()).toEqual([...references].sort());
    expect(
      errors.contains(
        "Admin refund did not complete every payment for attendee 42",
      ),
    ).toBe(false);
  });

  test("keeps provider writes inside the concurrency limit", async () => {
    const references = Array.from({ length: 7 }, (_, index) => `pi_${index}`);
    const firstWaveStarted = Promise.withResolvers<void>();
    const releaseFirstWave = Promise.withResolvers<void>();
    let active = 0;
    let mostActive = 0;
    const source = provider({
      refund: async (request) => {
        active += 1;
        mostActive = Math.max(mostActive, active);
        if (active === PROVIDER_REFUND_CONCURRENCY) firstWaveStarted.resolve();
        await releaseFirstWave.promise;
        active -= 1;
        return completedRefund(request);
      },
    });

    const refund = refundReadyCandidate(
      readyCandidateWithReferences(references, source),
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
    );
    await firstWaveStarted.promise;
    releaseFirstWave.resolve();

    expect((await refund).outcome).toBe("refunded");
    expect(mostActive).toBe(PROVIDER_REFUND_CONCURRENCY);
  });

  test("refunds a shared tagged reference once across attendees", async () => {
    const source = provider({ refunded: new Set(["pi_shared"]) });
    const inFlight = new Map<string, Promise<PreparedReferenceRefund>>();
    const results = await Promise.all(
      [11, 12].map((attendeeId) =>
        refundReadyCandidate(
          readyCandidateWithReferences(["pi_shared"], source, attendeeId),
          7,
          () => Promise.resolve(),
          authorizeEveryRefund(),
          inFlight,
        ),
      ),
    );

    expect(source.reads).toEqual([]);
    expect(source.refunds).toEqual(["pi_shared"]);
    expect(results.map(({ outcome }) => outcome)).toEqual([
      "refunded",
      "refunded",
    ]);
  });

  test("same raw text at different providers remains two charges", async () => {
    const stripe = provider({ refunded: new Set(["same_raw"]) });
    const square = provider({
      paymentProvider: "square",
      refunded: new Set(["same_raw"]),
    });
    const result = await refundReadyCandidate(
      readyCandidate(
        [
          { provider: stripe, reference: "same_raw" },
          { provider: square, reference: "same_raw" },
        ],
        stripe,
      ),
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
    );

    expect(stripe.refunds).toEqual(["same_raw"]);
    expect(square.refunds).toEqual(["same_raw"]);
    expect(result.returned.map(({ provider }) => provider)).toEqual([
      "stripe",
      "square",
    ]);
    expect(result.returned[0]?.index).not.toBe(result.returned[1]?.index);
  });

  test("an owner-review decision uses the tagged index, not raw text", async () => {
    const source = provider({ refunded: new Set(["pi_observe"]) });
    const candidate = readyCandidateWithReferences(["pi_observe"], source);
    const index = candidate.references[0]?.reference.index;
    if (index === undefined) throw new Error("the ready reference was missing");

    const observed = await refundReadyCandidate(
      candidate,
      7,
      collectingMarker().mark,
      () =>
        Promise.resolve({
          indexes: [index],
          kind: "owner_review",
          reason: "uncertain_keyless_refund",
        }),
    );
    expect(observed).toMatchObject({
      outcome: "withheld",
      reviews: [{ reason: { kind: "uncertain_keyless_refund" } }],
    });
    expect(source.refunds).toEqual([]);

    const sent = await refundReadyCandidate(
      candidate,
      7,
      collectingMarker().mark,
      authorizeEveryRefund(),
    );
    expect(sent.outcome).toBe("refunded");
    expect(source.refunds).toEqual(["pi_observe"]);
  });

  for (const [name, references, expected] of [
    ["complete", ["pi_done"], "refunded"],
    ["partial", ["pi_done", "pi_failed"], "errored"],
  ] as const) {
    test(`keeps a ${name} result when recording its marker fails`, async () => {
      const source = provider({ refunded: new Set(["pi_done"]) });
      const result = await refundReadyCandidate(
        readyCandidateWithReferences([...references], source),
        7,
        throwMarker,
        authorizeEveryRefund(),
      );

      expect(result.outcome).toBe(expected);
      expect(result.doubt).toBe("in_doubt");
      expect(errors.lastMessage()).toContain(
        "could not record returned payments for attendee 42",
      );
    });
  }
});
