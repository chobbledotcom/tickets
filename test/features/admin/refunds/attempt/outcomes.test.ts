import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { ReferenceRefund } from "#routes/admin/refunds/attempt.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "#routes/admin/refunds/provider-requests.ts";
import type { ReadyRefundCandidate } from "#routes/admin/refunds/readiness.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { refundReadyCandidate } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  completedRefund,
  provider,
  readyCandidate,
  readyCandidateWithReferences,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";

const withCanonicalIndexes = async (
  candidate: ReadyRefundCandidate,
): Promise<ReadyRefundCandidate> => ({
  ...candidate,
  references: await Promise.all(
    candidate.references.map(async (ready) => {
      const index = await paymentReferenceIndex(ready.reference);
      return {
        ...ready,
        reference: {
          ...ready.reference,
          index,
          matchingIndexes: [index],
        },
      };
    }),
  ),
});

const canonicalReadyCandidate = (
  ...input: Parameters<typeof readyCandidate>
): Promise<ReadyRefundCandidate> =>
  withCanonicalIndexes(readyCandidate(...input));

const canonicalReadyCandidateWithReferences = (
  ...input: Parameters<typeof readyCandidateWithReferences>
): Promise<ReadyRefundCandidate> =>
  withCanonicalIndexes(readyCandidateWithReferences(...input));

describeWithEnv("admin refund provider", { db: true }, () => {
  const errors = setupErrorSpy();

  test("sends the exact charge readiness already observed", async () => {
    const source = provider({ refunded: new Set(["pi_exact"]) });
    const observed = chargeMoney(731, 0, "GBP");

    const result = await refundReadyCandidate(
      await canonicalReadyCandidate(
        [{ charge: observed, reference: "pi_exact" }],
        source,
      ),
      7,
    );

    expect(source.reads).toEqual([]);
    expect(source.requests[0]?.charge).toBe(observed);
    expect(result.outcome).toBe("refunded");
    expect(result.returned[0]).toMatchObject({
      reference: {
        kind: "tagged",
        provider: "stripe",
        reference: "pi_exact",
      },
    });
  });

  test("reports an accepted refund as pending", async () => {
    const source = provider({ accepted: new Set(["pi_pending"]) });
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_pending"], source),
      7,
    );

    expect(result).toMatchObject({
      outcome: "pending",
      returned: [],
    });
  });

  for (const [state, blockedCharge, outcome] of [
    ["partly refunded", partlyRefundedCharge(), "pending"],
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
      const result = await refundReadyCandidate(
        await canonicalReadyCandidate(
          [
            { reference: "pi_clean_a" },
            { charge: blockedCharge, reference: "pi_blocked" },
            { reference: "pi_clean_b" },
          ],
          source,
        ),
        7,
      );

      expect(source.refunds).toEqual([]);
      expect(result).toMatchObject({ outcome, returned: [] });
    });
  }

  for (const [name, reference, input, stored] of [
    [
      "stored canonical answer",
      "pi_stored_canonical",
      { kind: "already_returned" as const },
      true,
    ],
    [
      "provider observation",
      "pi_provider_observation",
      { charge: fullyRefundedMoney() },
      false,
    ],
  ] as const) {
    test(`answers returned money from a ${name} without sending`, async () => {
      const source = provider();
      const candidate = await canonicalReadyCandidate(
        [{ ...input, reference }],
        source,
      );
      if (stored) {
        await markProviderRefundsReturned([candidate.references[0]!.reference]);
      }
      const result = await refundReadyCandidate(candidate, 7);

      expect(source.refunds).toEqual([]);
      expect(result.outcome).toBe("refunded");
    });
  }

  test("maps a durable provider rejection to a failed result", async () => {
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_no"], provider()),
      7,
    );

    expect(result).toMatchObject({ outcome: "failed", returned: [] });
  });

  test("keeps a possibly-sent owner decision pending for review", async () => {
    const reference = "pi_possibly_sent";
    const source = provider();
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences([reference], source),
      7,
      new Map(),
      (target) =>
        Promise.resolve({
          authority: { id: 1, referenceIndex: "possibly-sent", revision: 2 },
          kind: "needs_owner_choice",
          reason: "possibly_sent",
          reference: target.reference,
        }),
    );

    expect(source.refunds).toEqual([]);
    expect(result).toMatchObject({ outcome: "pending", returned: [] });
  });

  test("withholds when the provider proves no request was sent", async () => {
    const source = provider({
      refund: () =>
        Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
    });
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_not_sent"], source),
      7,
    );

    expect(result).toMatchObject({ outcome: "withheld", returned: [] });
  });

  test("withholds when an authority revision changed", async () => {
    const source = provider();
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_changed"], source),
      7,
      new Map(),
      (target) =>
        Promise.resolve({ kind: "changed", reference: target.reference }),
    );

    expect(result).toMatchObject({ outcome: "withheld", returned: [] });
    expect(source.refunds).toEqual([]);
  });

  test("keeps an uncertain authority pending", async () => {
    const source = provider({ throws: new Set(["pi_boom"]) });
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_boom"], source),
      7,
    );

    expect(result).toMatchObject({
      outcome: "pending",
      returned: [],
    });
  });

  test("keeps an unreadable completed marker pending for later evidence", async () => {
    const source = provider();
    const result = await refundReadyCandidate(
      await canonicalReadyCandidate(
        [{ kind: "already_returned", reference: "pi_unreadable" }],
        source,
      ),
      7,
      new Map(),
      (target) =>
        Promise.resolve({
          admission: {
            kind: "read_failed",
            read: { reason: "network_error", status: "unavailable" },
          },
          kind: "withheld",
          reference: target.reference,
        }),
    );

    expect(result).toMatchObject({ outcome: "pending", returned: [] });
    expect(source.refunds).toEqual([]);
  });

  test("returns only references whose authority says money returned", async () => {
    const source = provider({ refunded: new Set(["pi_ok"]) });
    const result = await refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(["pi_ok", "pi_bad"], source),
      7,
    );

    expect(result.outcome).toBe("failed");
    expect(result.returned.map(({ reference }) => reference.reference)).toEqual(
      ["pi_ok"],
    );
    expect(
      errors.contains("Admin refund did not complete all 2 payments"),
    ).toBe(true);
  });

  test("keeps provider requests inside the concurrency limit", async () => {
    const references = Array.from({ length: 7 }, (_, index) => `pi_${index}`);
    const firstWaveStarted = Promise.withResolvers<void>();
    const releaseFirstWave = Promise.withResolvers<void>();
    let active = 0;
    let mostActive = 0;
    const source = provider({
      refund: async (request) => {
        active++;
        mostActive = Math.max(mostActive, active);
        if (active === PROVIDER_REFUND_CONCURRENCY) firstWaveStarted.resolve();
        await releaseFirstWave.promise;
        active--;
        return completedRefund(request);
      },
    });

    const refund = refundReadyCandidate(
      await canonicalReadyCandidateWithReferences(references, source),
      7,
    );
    await firstWaveStarted.promise;
    releaseFirstWave.resolve();

    expect((await refund).outcome).toBe("refunded");
    expect(mostActive).toBe(PROVIDER_REFUND_CONCURRENCY);
  });

  test("requests a shared tagged reference once across attendees", async () => {
    const source = provider({ refunded: new Set(["pi_shared"]) });
    const inFlight = new Map<string, Promise<ReferenceRefund>>();
    const results = await Promise.all(
      [11, 12].map(async (attendeeId) =>
        refundReadyCandidate(
          await canonicalReadyCandidateWithReferences(
            ["pi_shared"],
            source,
            attendeeId,
          ),
          7,
          inFlight,
        ),
      ),
    );

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
      await canonicalReadyCandidate(
        [
          { provider: stripe, reference: "same_raw" },
          { provider: square, reference: "same_raw" },
        ],
        stripe,
      ),
      7,
    );

    expect(stripe.refunds).toEqual(["same_raw"]);
    expect(square.refunds).toEqual(["same_raw"]);
    expect(result.returned.map(({ reference }) => reference.provider)).toEqual([
      "stripe",
      "square",
    ]);
    expect(result.returned[0]?.reference.index).not.toBe(
      result.returned[1]?.reference.index,
    );
  });
});
