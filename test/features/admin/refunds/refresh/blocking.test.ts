import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { pendingRefundMoney, refresh, runHarness } from "./helpers.ts";

describe("refresh payment under an attendee claim", () => {
  test("releases the row fence while durable authority observes a refund", async () => {
    const run = runHarness({
      observed: pendingRefundMoney(),
    });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.provider.refunds).toEqual([]);
    expect(run.observed).toEqual([
      expect.objectContaining({ mode: "observe_only" }),
    ]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("reports readiness evidence and releases a fresh unread claim", async () => {
    const run = runHarness({
      readiness: {
        kind: "not_ready",
        observations: [],
        reads: [
          {
            evidence: {
              provider: "stripe",
              reference: "pi_refresh",
              status: "missing",
            },
            index: "old_pi_refresh",
          },
        ],
        reason: "provider_evidence",
      },
    });

    expect(await refresh(run)).toEqual({
      kind: "not_ready",
      message: "Payment pi_refresh at stripe does not recognize the payment.",
    });
    expect(run.observed).toEqual([]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
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

  for (
    const [name, count] of [
      ["no attendee", 0],
      ["more than one attendee", 2],
    ] as const
  ) {
    test(`fails when readiness returns ${name}`, async () => {
      const run = runHarness();
      const candidates = Array.from({ length: count }).flatMap(
        () => run.ready.candidates,
      );

      await expect(
        refresh(run, {
          ...run.dependencies,
          prepare: () => Promise.resolve({ candidates, kind: "ready" }),
        }),
      ).rejects.toThrow("Refresh readiness must return exactly one attendee");
      expect(run.calls.record).toBe(0);
    });
  }
});
