import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  candidate,
  completedRefund,
  finishedCounts,
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

describe("admin refund authority > ordered local writes", () => {
  test("waits for the complete provider wave before ledger and retirement", async () => {
    const events: string[] = [];
    const allStarted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let active = 0;
    let mostActive = 0;
    const source = provider({
      refund: async (request) => {
        events.push(`send:start:${request.paymentReference}`);
        active++;
        mostActive = Math.max(mostActive, active);
        if (active === 3) allStarted.resolve();
        await finish.promise;
        active--;
        events.push(`send:end:${request.paymentReference}`);
        return completedRefund(request);
      },
    });
    const refund = processRefundBatchAt(
      source,
      [
        candidate([{ reference: "pi_first" }], 11),
        candidate([{ reference: "pi_second" }], 12),
        candidate([{ reference: "pi_third" }], 13),
      ],
      7,
      {
        claim: grantingRowClaim(),
        record: (postings) => {
          events.push("ledger");
          return recordEveryRefund(postings);
        },
        recordAuthorities: (authorities) => {
          events.push(`retire:${authorities.length}`);
          return Promise.resolve();
        },
      },
    );

    await allStarted.promise;
    expect(events.some((event) => event === "ledger")).toBe(false);
    finish.resolve();
    const counts = finishedCounts(await refund);

    const lastProviderAnswer = events.findLastIndex((event) =>
      event.startsWith("send:end:")
    );
    expect(events.indexOf("ledger")).toBeGreaterThan(lastProviderAnswer);
    expect(events.indexOf("retire:3")).toBeGreaterThan(
      events.indexOf("ledger"),
    );
    expect(mostActive).toBe(3);
    expect(counts.refundedCount).toBe(3);
  });

  test("a ledger throw preserves every returned row before propagating", async () => {
    const active = Array.from({ length: 2 }, (_, index) => `pi_${index}`);
    const knownReturned = "pi_known_returned";
    const claim = grantingRowClaim(
      new Map([
        [11, active.map((reference) => `sess_${reference}`)],
        [12, [`sess_${knownReturned}`]],
      ]),
    );
    const source = provider({ refunded: new Set(active) });

    await expect(
      processRefundBatchAt(
        source,
        [
          candidate(active.map((reference) => ({ reference })), 11),
          candidate(
            [{ reference: knownReturned, refundState: "completed" }],
            12,
          ),
        ],
        7,
        {
          claim,
          record: () => Promise.reject(new Error("ledger write failed")),
        },
      ),
    ).rejects.toThrow("ledger write failed");

    expect(new Set(claim.unrecorded[0])).toEqual(
      new Set([
        ...active.map((reference) => `sess_${reference}`),
        `sess_${knownReturned}`,
      ]),
    );
    expect(claim.released[0]).toHaveLength(3);
  });

  test("a provider throw still preserves returned evidence from another wave", async () => {
    const active = Array.from({ length: 2 }, (_, index) => `pi_throw_${index}`);
    const returned = "pi_returned_after_throw";
    const returnedSession = `sess_${returned}`;
    const claim = grantingRowClaim(
      new Map([
        [11, active.map((reference) => `sess_${reference}`)],
        [12, [returnedSession]],
      ]),
    );
    const source = provider({
      refund: (request) =>
        request.paymentReference === active[0]
          ? Promise.reject(new Error("provider call broke"))
          : Promise.resolve(completedRefund(request)),
    });

    await expect(
      processRefundBatchAt(
        source,
        [
          candidate(active.map((reference) => ({ reference })), 11),
          candidate([{ reference: returned, refundState: "completed" }], 12),
        ],
        7,
        { claim },
      ),
    ).rejects.toThrow("provider call broke");

    expect(claim.unrecorded).toEqual([[returnedSession]]);
    expect(claim.released[0]).toContain(returnedSession);
  });
});
