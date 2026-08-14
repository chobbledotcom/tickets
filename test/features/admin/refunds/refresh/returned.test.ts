import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { expectNewCompletedRefresh, refresh, runHarness } from "./helpers.ts";

describeWithEnv("refresh payment under an attendee claim", { db: true }, () => {
  test("records exact returned evidence without asking the provider to send", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expectNewCompletedRefresh(run);
    expect(run.recorded).toEqual([[run.reference]]);
    expect(run.authorities).toHaveLength(1);
    expect(run.authorities[0]).toEqual([
      expect.objectContaining({
        referenceIndex: await paymentReferenceIndex(run.reference),
      }),
    ]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("marks the exact returned rows while releasing a missed ledger post", async () => {
    const run = runHarness({
      existingReview: { kind: "partially_returned_obligation" },
      observed: fullyRefundedMoney(),
      posted: false,
    });

    expect(await refresh(run)).toEqual({
      kind: "needs_review",
      message:
        "This payment needs an owner review before another refund can be attempted.",
    });
    expect(run.calls.confirm).toBe(0);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.reviewChanges).toEqual([new Map()]);
  });

  test("reuses a completed marker without a provider read or send", async () => {
    const run = runHarness({ observed: null, paymentOnly: false });
    await markProviderRefundsReturned(run.references);

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

  test("keeps a returned authority due when local recording cannot start", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expect(
      refresh(run, {
        ...run.dependencies,
        record: () => Promise.reject(new Error("ledger unavailable")),
      }),
    ).rejects.toThrow("ledger unavailable");

    expect(run.authorities).toEqual([]);
    expect(run.claim.unrecorded).toEqual([run.reference.rowSessionIds]);
    expect(run.claim.released).toEqual([run.reference.rowSessionIds]);
  });

  test("keeps recorded row facts when authority retirement fails", async () => {
    const run = runHarness({ observed: fullyRefundedMoney() });

    await expect(
      refresh(run, {
        ...run.dependencies,
        recordAuthorities: () =>
          Promise.reject(new Error("authority unavailable")),
      }),
    ).rejects.toThrow("authority unavailable");

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
