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
  test("waits for the provider answer before ledger and retirement", async () => {
    const events: string[] = [];
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const source = provider({
      refund: async (request) => {
        events.push(`send:start:${request.paymentReference}`);
        started.resolve();
        await finish.promise;
        events.push(`send:end:${request.paymentReference}`);
        return completedRefund(request);
      },
    });
    const refund = processRefundBatchAt(
      source,
      [candidate([{ reference: "pi_first" }], 11)],
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

    await started.promise;
    expect(events.some((event) => event === "ledger")).toBe(false);
    finish.resolve();
    const counts = finishedCounts(await refund);

    const lastProviderAnswer = events.findLastIndex((event) =>
      event.startsWith("send:end:")
    );
    expect(events.indexOf("ledger")).toBeGreaterThan(lastProviderAnswer);
    expect(events.indexOf("retire:1")).toBeGreaterThan(
      events.indexOf("ledger"),
    );
    expect(counts.refundedCount).toBe(1);
  });

  test("a ledger throw preserves every returned row before propagating", async () => {
    const active = ["pi_active"];
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
          candidate(
            active.map((reference) => ({ reference })),
            11,
          ),
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
    expect(claim.released[0]).toHaveLength(2);
  });

  test("a provider throw still preserves returned evidence from a sibling", async () => {
    const active = ["pi_throw"];
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
          candidate(
            active.map((reference) => ({ reference })),
            11,
          ),
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
