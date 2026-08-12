import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { expectNewCompletedRefresh, refresh, runHarness } from "./helpers.ts";

describe("refresh payment under an attendee claim", () => {
  test("records exact returned evidence without asking the provider to send", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expectNewCompletedRefresh(run);
    expect(run.recorded).toEqual([[run.reference]]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("marks the exact returned rows while releasing a missed ledger post", async () => {
    const run = runHarness({
      existingReview: { kind: "uncertain_keyless_refund" },
      observed: fullyRefundedMoney(),
      posted: false,
    });

    expect(await refresh(run)).toEqual({ kind: "returned", posted: false });
    expect(run.calls.confirm).toBe(0);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.reviewChanges).toEqual([new Map()]);
  });

  test("reuses a completed marker without a provider read or send", async () => {
    const run = runHarness({ observed: null, paymentOnly: false });

    await expectNewCompletedRefresh(run);
    expect(run.calls.prepare).toBe(1);
    expect(run.provider.reads).toEqual([]);
    expect(run.calls.confirm).toBe(1);
  });

  test("releases after durable money facts even when confirmation fails", async () => {
    const run = runHarness({
      confirmationError: new Error("activity unavailable"),
      observed: fullyRefundedMoney(),
    });

    await expect(refresh(run)).rejects.toThrow("activity unavailable");
    expect(run.calls.confirm).toBe(1);
    expect(run.claim.recorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("keeps a resumed keyed refund protected when no return is visible yet", async () => {
    const run = runHarness({ inherited: "keyed" });

    expect(await refresh(run)).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect(run.marked).toEqual([[]]);
    expect(run.calls.record).toBe(0);
    expect(run.claim.released).toEqual([]);
  });

  test("keeps the claim when returned evidence cannot be marked", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expect(
      refresh(run, {
        ...run.dependencies,
        markReturned: () => Promise.reject(new Error("marker unavailable")),
      }),
    ).rejects.toThrow("marker unavailable");

    expect(run.calls.record).toBe(0);
    expect(run.claim.released).toEqual([]);
  });

  test("records the returned row before raising a ledger failure", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expect(
      refresh(run, {
        ...run.dependencies,
        record: () => Promise.reject(new Error("ledger unavailable")),
      }),
    ).rejects.toThrow("ledger unavailable");

    expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("releases a resumed claim after returned money is durable", async () => {
    const run = runHarness({
      inherited: "keyed",
      observed: fullyRefundedMoney(),
    });

    await expectNewCompletedRefresh(run);
    expect(run.claim.recorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("records a returned reference while its independent sibling remains", async () => {
    const run = runHarness({
      observed: fullyRefundedMoney(),
      siblingObserved: chargeMoney(),
    });

    expect(await refresh(run)).toEqual({ kind: "current" });
    expect(run.recorded).toEqual([[run.reference]]);
    expect(run.claim.recorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([
      run.references.flatMap(({ rowSessionIds }) => rowSessionIds),
    ]);
    expect(run.calls.confirm).toBe(0);
    expect(run.calls.paymentOnly).toBe(0);
  });
});
