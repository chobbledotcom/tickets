import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundCandidateAtProvider } from "#routes/admin/refunds/provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { PaymentRefundResult } from "#shared/payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { candidate, candidateWithReferences } from "./helpers.ts";
import "./provider/batch.test.ts";
import "./provider/sumup.test.ts";

/** Provider that refunds exactly the references in `refunded`, reports the
 * ones in `alreadyRefunded` as refunded on the follow-up check, and throws for
 * references in `throws`. */
const provider = ({
  refunded = new Set<string>(),
  pending = new Set<string>(),
  alreadyRefunded = new Set<string>(),
  throws = new Set<string>(),
}: {
  refunded?: Set<string>;
  pending?: Set<string>;
  alreadyRefunded?: Set<string>;
  throws?: Set<string>;
} = {}) => ({
  isPaymentRefunded: (reference: string) =>
    Promise.resolve(alreadyRefunded.has(reference)),
  refundPayment: (reference: string) => {
    if (throws.has(reference)) throw new Error(`boom ${reference}`);
    const result: PaymentRefundResult = refunded.has(reference)
      ? "refunded"
      : pending.has(reference)
        ? "pending"
        : "failed";
    return Promise.resolve(result);
  },
  refundRetryMode: "idempotent" as const,
  type: "stripe" as const,
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

describe("admin refund provider", () => {
  const errors = setupErrorSpy();

  test("counts a reference already marked refunded without calling the provider", async () => {
    let refundCalls = 0;
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      {
        isPaymentRefunded: () => Promise.resolve(false),
        refundPayment: () => {
          refundCalls++;
          return Promise.resolve("failed" as const);
        },
        refundRetryMode: "idempotent",
        type: "stripe",
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

  test("keeps an accepted pending refund unmarked", async () => {
    const marker = collectingMarker();
    const result = await refundCandidateAtProvider(
      provider({ pending: new Set(["pi_pending"]) }),
      candidateWithReferences(["pi_pending"]),
      7,
      marker.mark,
    );

    expect(result.outcome).toBe("pending");
    expect(marker.marked).toEqual([]);
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
