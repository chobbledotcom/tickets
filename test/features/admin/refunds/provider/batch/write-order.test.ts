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
