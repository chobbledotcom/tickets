import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { pendingRefundMoney, refresh, runHarness } from "./helpers.ts";

describeWithEnv("refresh payment under an attendee claim", { db: true }, () => {
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

  test("fails loudly when a completed marker loses provider evidence", async () => {
    const run = runHarness({ observed: null });

    await expect(
      refresh(run, {
        ...run.dependencies,
        request: (target) =>
          Promise.resolve({
            admission: {
              kind: "read_failed",
              read: { reason: "network_error", status: "unavailable" },
            },
            kind: "withheld",
            reference: target.reference,
          }),
      }),
    ).rejects.toThrow("Observed payment refresh lost its provider evidence");
    expect(run.provider.refunds).toEqual([]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("fails loudly when observation reaches an owner revision fence", async () => {
    const run = runHarness();

    await expect(
      refresh(run, {
        ...run.dependencies,
        request: (target) =>
          Promise.resolve({ kind: "changed", reference: target.reference }),
      }),
    ).rejects.toThrow(
      "Observed payment refresh reached an owner revision fence",
    );
    expect(run.provider.refunds).toEqual([]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  for (const [name, wrongReference] of [
    [
      "provider",
      { kind: "tagged", provider: "square", reference: "pi_refresh" },
    ],
    [
      "reference",
      { kind: "tagged", provider: "stripe", reference: "pi_other" },
    ],
  ] as const) {
    test(`rejects an authority answer for a different ${name}`, async () => {
      const run = runHarness();

      await expect(
        refresh(run, {
          ...run.dependencies,
          request: () =>
            Promise.resolve({ kind: "unchanged", reference: wrongReference }),
        }),
      ).rejects.toThrow("Refund authority answered for a different payment");
      expect(run.calls.record).toBe(0);
      expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
    });
  }

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

  for (const [name, count] of [
    ["no attendee", 0],
    ["more than one attendee", 2],
  ] as const) {
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
