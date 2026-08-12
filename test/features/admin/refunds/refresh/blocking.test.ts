import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { pendingRefundMoney, refresh, runHarness } from "./helpers.ts";

describe("refresh payment under an attendee claim", () => {
  test("retains an inherited keyless claim when no refund is visible", async () => {
    const run = runHarness({ inherited: "keyless" });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.provider.sends).toBe(0);
    expect(run.claim.released).toEqual([]);
  });

  test("retains the claim while an observed refund is still settling", async () => {
    const run = runHarness({
      observed: pendingRefundMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.claim.released).toEqual([]);
  });

  test("reports readiness evidence and releases a fresh unread claim", async () => {
    const run = runHarness({
      readiness: {
        kind: "not_ready",
        reads: [
          {
            evidence: {
              attempts: [],
              reason: "no_validating_provider",
              reference: "pi_refresh",
              source: "untagged",
              status: "unresolved",
            },
            index: "old_pi_refresh",
          },
        ],
        reason: "provider_evidence",
      },
    });

    expect(await refresh(run)).toEqual({
      kind: "not_ready",
      message:
        "No configured payment provider recognizes this payment. Add the provider it was taken with, or refund it from that provider's dashboard.",
    });
    expect(run.marked).toEqual([]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("does not erase an existing unrecorded mark when readiness fails", async () => {
    const run = runHarness({
      existingUnrecorded: ["sess-missed"],
      readiness: {
        indexes: ["old_pi_refresh"],
        kind: "not_ready",
        reason: "historical_marker",
      },
    });

    expect(await refresh(run)).toMatchObject({ kind: "not_ready" });
    expect(run.claim.unrecorded).toEqual([[]]);
  });

  test("retains an inherited claim when provider evidence cannot answer", async () => {
    const run = runHarness({
      inherited: "keyed",
      readiness: { kind: "not_ready", reason: "claim_changed" },
    });

    expect(await refresh(run)).toEqual({
      kind: "not_ready",
      message:
        "the payment rows changed while their providers were being recorded",
    });
    expect(run.claim.released).toEqual([]);
  });

  const refusingClaim = (
    result: Awaited<ReturnType<RowClaim["claim"]>>,
  ): RowClaim => ({
    claim: () => Promise.resolve(result),
    settle: () => Promise.reject(new Error("nothing was claimed")),
  });

  test("does not prepare after another live refund owns the claim", async () => {
    const run = runHarness();
    const claim = refusingClaim({
      blockedBy: { kind: "held" },
      kind: "blocked",
    });

    expect(
      await refresh(run, {
        ...run.dependencies,
        claim,
      }),
    ).toEqual({ kind: "blocked", reason: "refund_in_progress" });
    expect(run.calls.prepare).toBe(0);
  });

  test("does not prepare after the loaded payment set changes", async () => {
    const run = runHarness();
    const claim = refusingClaim({ kind: "changed" });

    expect(
      await refresh(run, {
        ...run.dependencies,
        claim,
      }),
    ).toEqual({
      kind: "not_ready",
      message:
        "The attendee or payment set changed while this refresh was starting. Try again.",
    });
    expect(run.calls.prepare).toBe(0);
  });
});
