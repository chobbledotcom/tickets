import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { refundCandidateAtProvider } from "#routes/admin/refunds/provider.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const candidateWithReferences = (references: string[]): RefundCandidate => ({
  attendee: { id: 42 } as RefundCandidate["attendee"],
  references: references.map((reference) => ({
    providerRefunded: false,
    reference,
    sessionIds: [`sess_${reference}`],
  })),
});

const refundingProvider = (refunded: Set<string>) => ({
  isPaymentRefunded: (_reference: string) => Promise.resolve(false),
  refundPayment: (reference: string) =>
    Promise.resolve(refunded.has(reference)),
});

const throwMarker = () => {
  throw new Error("marker write failed");
};

describe("admin refund provider", () => {
  const errors = setupErrorSpy();

  test("keeps a successful provider refund successful when recording the marker fails", async () => {
    const result = await refundCandidateAtProvider(
      refundingProvider(new Set(["pi_done"])),
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
      refundingProvider(new Set(["pi_done"])),
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
