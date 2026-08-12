import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundRunDependencies } from "#routes/admin/refunds/provider.ts";
import type { ArmRefundDispatchRequest } from "#shared/db/payment-refund-dispatch.ts";
import { armEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidate,
  completedRefund,
  finishedCounts,
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const refundThreeAtOnce = async (
  markReturned: NonNullable<RefundRunDependencies["markReturned"]>,
) => {
  const allProviderCallsStarted = Promise.withResolvers<void>();
  const finishProviderCalls = Promise.withResolvers<void>();
  let activeProviderCalls = 0;
  let mostProviderCalls = 0;
  const source = provider({
    refund: async (request) => {
      activeProviderCalls++;
      mostProviderCalls = Math.max(mostProviderCalls, activeProviderCalls);
      if (activeProviderCalls === 3) allProviderCallsStarted.resolve();
      await finishProviderCalls.promise;
      activeProviderCalls--;
      return completedRefund(request);
    },
  });
  let activePaymentWrites = 0;
  let mostPaymentWrites = 0;
  const paymentWrite = async <T>(write: () => Promise<T>): Promise<T> => {
    activePaymentWrites++;
    mostPaymentWrites = Math.max(mostPaymentWrites, activePaymentWrites);
    await Promise.resolve();
    const result = await write();
    activePaymentWrites--;
    return result;
  };
  const arm = armEveryRefund();
  const refund = processRefundBatchAt(
    source,
    [
      candidate([{ reference: "pi_first" }], 11),
      candidate([{ reference: "pi_second" }], 12),
      candidate([{ reference: "pi_third" }], 13),
    ],
    7,
    {
      arm: (request: ArmRefundDispatchRequest) =>
        paymentWrite(() => arm(request)),
      claim: grantingRowClaim(),
      markReturned: (references) =>
        paymentWrite(() => markReturned(references)),
      record: recordEveryRefund,
    },
  );

  await allProviderCallsStarted.promise;
  finishProviderCalls.resolve();
  return {
    counts: finishedCounts(await refund),
    mostPaymentWrites,
    mostProviderCalls,
    source,
  };
};

describe("admin refund provider > provider wave writes", () => {
  test("orders writes, batches markers, and keeps provider overlap", async () => {
    const markedIndexes: string[][] = [];
    const { counts, mostPaymentWrites, mostProviderCalls, source } =
      await refundThreeAtOnce((references) => {
        markedIndexes.push(references.map(({ index }) => index));
        return Promise.resolve();
      });

    expect(source.refunds).toHaveLength(3);
    expect(mostProviderCalls).toBe(3);
    expect(mostPaymentWrites).toBe(1);
    expect(markedIndexes).toHaveLength(1);
    expect(new Set(markedIndexes[0])).toEqual(
      new Set([
        "index_of_stripe_pi_first",
        "index_of_stripe_pi_second",
        "index_of_stripe_pi_third",
      ]),
    );
    expect(counts.refundedCount).toBe(3);
  });

  test("arms one exact send set before all provider calls and local writes", async () => {
    const events: string[] = [];
    const liveReferences = [
      "pi_first_a",
      "pi_first_b",
      "pi_first_c",
      "pi_second_a",
      "pi_second_b",
      "pi_second_c",
    ];
    const source = provider({
      paymentProvider: "square",
      refund: async (request) => {
        events.push(`send:start:${request.paymentReference}`);
        await Promise.resolve();
        events.push(`send:end:${request.paymentReference}`);
        return completedRefund(request);
      },
    });
    const armRefunds = armEveryRefund();
    const armedIndexes: string[][] = [];

    const counts = finishedCounts(
      await processRefundBatchAt(
        source,
        [
          candidate(
            [
              ...liveReferences.slice(0, 3).map((reference) => ({ reference })),
              { reference: "pi_already_returned", refundState: "completed" },
            ],
            11,
          ),
          candidate(
            liveReferences.slice(3).map((reference) => ({ reference })),
            12,
          ),
        ],
        7,
        {
          arm: (request) => {
            armedIndexes.push([...request.indexes]);
            return armRefunds(request);
          },
          claim: grantingRowClaim(),
          markReturned: () => {
            events.push("marker");
            return Promise.resolve();
          },
          record: (postings) => {
            events.push("ledger");
            return recordEveryRefund(postings);
          },
        },
      ),
    );

    expect(armedIndexes).toHaveLength(1);
    expect(new Set(armedIndexes[0])).toEqual(
      new Set(
        liveReferences.map((reference) => `index_of_square_${reference}`),
      ),
    );
    expect(new Set(source.refunds)).toEqual(new Set(liveReferences));
    const firstLocalWrite = events.findIndex(
      (event) => event === "marker" || event === "ledger",
    );
    const lastProviderAnswer = events.findLastIndex((event) =>
      event.startsWith("send:end:"),
    );
    expect(firstLocalWrite).toBeGreaterThan(lastProviderAnswer);
    expect(counts.refundedCount).toBe(2);
  });

  test("one failed wave marker leaves every contributing attendee in doubt", async () => {
    const claim = grantingRowClaim(
      new Map([
        [11, ["sess_pi_first"]],
        [12, ["sess_pi_second"]],
      ]),
    );
    const source = provider({
      refunded: new Set(["pi_first", "pi_second"]),
    });

    const counts = finishedCounts(
      await processRefundBatchAt(
        source,
        [
          candidate([{ reference: "pi_first" }], 11),
          candidate([{ reference: "pi_second" }], 12),
        ],
        7,
        {
          claim,
          markReturned: () =>
            Promise.reject(new Error("the wave marker failed")),
          record: recordEveryRefund,
        },
      ),
    );

    expect(counts.refundedCount).toBe(2);
    expect(claim.released).toEqual([[]]);
  });

  test("a failed marker does not hold an attendee whose money did not return", async () => {
    const returnedSession = "sess_pi_returned";
    const rejectedSession = "sess_pi_rejected";
    const claim = grantingRowClaim(
      new Map([
        [11, [returnedSession]],
        [12, [rejectedSession]],
      ]),
    );
    const source = provider({ refunded: new Set(["pi_returned"]) });

    const counts = finishedCounts(
      await processRefundBatchAt(
        source,
        [
          candidate([{ reference: "pi_returned" }], 11),
          candidate([{ reference: "pi_rejected" }], 12),
        ],
        7,
        {
          claim,
          markReturned: () => Promise.reject(new Error("the marker failed")),
          record: recordEveryRefund,
        },
      ),
    );

    expect(counts).toMatchObject({ failedCount: 1, refundedCount: 1 });
    expect(claim.released).toEqual([[rejectedSession]]);
  });

  test("preserves every returned row when the combined ledger write fails", async () => {
    const activeReferences = Array.from(
      { length: 5 },
      (_, index) => `pi_active_${index}`,
    );
    const returnedReference = "pi_later_returned";
    const attendees = [
      candidate(
        activeReferences.map((reference) => ({ reference })),
        11,
      ),
      candidate(
        [{ reference: returnedReference, refundState: "completed" }],
        12,
      ),
    ];
    const held = new Map(
      attendees.map(({ attendee, references }) => [
        attendee.id,
        references.flatMap(({ rowSessionIds }) => rowSessionIds),
      ]),
    );
    const claim = grantingRowClaim(held);
    const source = provider({ refunded: new Set(activeReferences) });
    let ledgerCalls = 0;
    let postedAttendees: number[] = [];

    await expect(
      processRefundBatchAt(source, attendees, 7, {
        claim,
        markReturned: () => Promise.resolve(),
        record: (postings) => {
          ledgerCalls++;
          postedAttendees = postings.map(({ attendeeId }) => attendeeId);
          return Promise.reject(new Error("the combined ledger write failed"));
        },
      }),
    ).rejects.toThrow("the combined ledger write failed");

    expect(new Set(source.refunds)).toEqual(new Set(activeReferences));
    expect(ledgerCalls).toBe(1);
    expect(postedAttendees).toEqual([11, 12]);
    expect(claim.unrecorded).toHaveLength(1);
    expect(claim.unrecorded[0]).toContain(`sess_${returnedReference}`);
  });

  test("a provider throw keeps every attendee whose send was armed", async () => {
    const claim = grantingRowClaim(
      new Map([
        [11, ["sess_pi_first"]],
        [12, ["sess_pi_second"]],
      ]),
    );
    const source = provider({
      refund: (request) =>
        request.paymentReference === "pi_second"
          ? Promise.reject(new Error("the provider connection broke"))
          : Promise.resolve(completedRefund(request)),
    });

    await expect(
      processRefundBatchAt(
        source,
        [
          candidate([{ reference: "pi_first" }], 11),
          candidate([{ reference: "pi_second" }], 12),
        ],
        7,
        {
          claim,
          markReturned: () => Promise.resolve(),
          record: recordEveryRefund,
        },
      ),
    ).rejects.toThrow("the provider connection broke");

    expect(new Set(source.refunds)).toEqual(new Set(["pi_first", "pi_second"]));
    expect(claim.released).toEqual([]);
  });

  test("a provider throw preserves returned evidence in a later wave", async () => {
    const activeReferences = Array.from(
      { length: 5 },
      (_, index) => `pi_throw_${index}`,
    );
    const returnedReference = "pi_returned_after_throw";
    const returnedSession = `sess_${returnedReference}`;
    const claim = grantingRowClaim(
      new Map([
        [11, activeReferences.map((reference) => `sess_${reference}`)],
        [12, [returnedSession]],
      ]),
    );
    const source = provider({
      refund: (request) =>
        request.paymentReference === activeReferences[0]
          ? Promise.reject(new Error("the provider call broke"))
          : Promise.resolve(completedRefund(request)),
    });

    await expect(
      processRefundBatchAt(
        source,
        [
          candidate(
            activeReferences.map((reference) => ({ reference })),
            11,
          ),
          candidate(
            [{ reference: returnedReference, refundState: "completed" }],
            12,
          ),
        ],
        7,
        { claim, markReturned: () => Promise.resolve() },
      ),
    ).rejects.toThrow("the provider call broke");

    expect(new Set(source.refunds)).toEqual(new Set(activeReferences));
    expect(claim.unrecorded).toEqual([[returnedSession]]);
    expect(claim.released).toEqual([[returnedSession]]);
  });

  test("a shared armed payment keeps every holder when its provider throws", async () => {
    const claim = grantingRowClaim(
      new Map([
        [11, ["sess_shared_11"]],
        [12, ["sess_shared_12"]],
      ]),
    );
    const source = provider({
      refund: () => Promise.reject(new Error("the shared send broke")),
    });

    await expect(
      processRefundBatchAt(
        source,
        [
          candidate([{ reference: "pi_shared" }], 11),
          candidate([{ reference: "pi_shared" }], 12),
        ],
        7,
        { claim, markReturned: () => Promise.resolve() },
      ),
    ).rejects.toThrow("the shared send broke");

    expect(source.refunds).toEqual(["pi_shared"]);
    expect(claim.released).toEqual([]);
  });
});
