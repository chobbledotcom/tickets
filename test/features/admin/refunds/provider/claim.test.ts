import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundCandidateAtProvider } from "#routes/admin/refunds/attempt.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import {
  processRefundBatch,
  type RefundWrites,
} from "#routes/admin/refunds/provider.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoneyWith,
  refundObservation,
  refundReference,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  candidate,
  candidateWithReferences,
  finishedCounts,
  holdingClaim,
  provider,
} from "./helpers.ts";

const recordEveryRefund: NonNullable<RefundWrites["record"]> = (attendees) =>
  Promise.resolve(
    new Map(attendees.map(({ attendeeId }) => [attendeeId, true])),
  );

describe("admin refund provider > the claim", () => {
  const errors = setupErrorSpy();

  /** A claim that refuses because another run already holds these attendees. */
  const blockedRowClaim = (): RowClaim => ({
    claim: () =>
      Promise.resolve({ blockedBy: { kind: "held" }, kind: "blocked" }),
    release: () => Promise.resolve(),
  });

  test("a blocked run reports settling without asking the provider", async () => {
    const untouched = provider({ refundCapability: "keyless" });
    const result = await processRefundBatch(
      untouched,
      [candidate([{ reference: "pi_held", refundState: "none" }])],
      7,
      { claim: blockedRowClaim() },
    );

    expect(result).toEqual({
      kind: "blocked",
      reason: "refund_in_progress",
    });
    expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
    expect(errors.calls).toEqual([]);
  });

  test("the whole batch is held by one claim, not one per attendee", async () => {
    const rowClaim = grantingRowClaim(
      new Map([
        [11, ["sess_pi_1"]],
        [12, ["sess_pi_2"]],
        [13, ["sess_pi_3"]],
      ]),
    );
    const claimed: number[][] = [];
    const counting: RowClaim = {
      claim: (attendees, capability) => {
        claimed.push(attendees.map((attendee) => attendee.attendeeId));
        return rowClaim.claim(attendees, capability);
      },
      release: rowClaim.release,
    };

    await processRefundBatch(
      provider({ refunded: new Set(["pi_1", "pi_2", "pi_3"]) }),
      [
        candidate([{ reference: "pi_1", refundState: "none" }], 11),
        candidate([{ reference: "pi_2", refundState: "none" }], 12),
        candidate([{ reference: "pi_3", refundState: "none" }], 13),
      ],
      7,
      {
        claim: counting,
        markReturned: () => Promise.resolve(),
        record: recordEveryRefund,
      },
    );

    expect(claimed).toEqual([[11, 12, 13]]);
    expect(rowClaim.released).toHaveLength(1);
  });

  test("a keyless batch whose call errored keeps its claim standing", async () => {
    const rowClaim = grantingRowClaim(new Map([[42, ["sess_pi_lost"]]]));

    await processRefundBatch(
      provider({
        refundCapability: "keyless",
        throws: new Set(["pi_lost"]),
      }),
      [candidate([{ reference: "pi_lost", refundState: "none" }])],
      7,
      { claim: rowClaim },
    );

    expect(rowClaim.released).toHaveLength(0);
  });

  test("a keyed batch whose call is uncertain keeps its claim standing", async () => {
    const rowClaim = grantingRowClaim(new Map([[42, ["sess_pi_uncertain"]]]));

    await processRefundBatch(
      provider({
        refundCapability: "keyed",
        throws: new Set(["pi_uncertain"]),
      }),
      [candidate([{ reference: "pi_uncertain", refundState: "none" }])],
      7,
      { claim: rowClaim },
    );

    expect(rowClaim.released).toEqual([]);
  });
});

describe("admin refund provider > a reference already sent back", () => {
  test("is not refunded again, whatever the loaded snapshot said", async () => {
    const untouched = provider({ refundCapability: "keyless" });

    const result = await refundCandidateAtProvider(
      untouched,
      candidateWithReferences(["pi_raced"]),
      7,
      () => Promise.resolve(),
      new Set([refundReference("pi_raced").index]),
    );

    expect(result.outcome).toBe("refunded");
    expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
  });
});

describe("admin refund provider > a release that fails", () => {
  const errors = setupErrorSpy();

  test("reports it and leaves the run's answer alone", async () => {
    const refusingRelease = holdingClaim(
      () => Promise.reject(new Error("the row would not let go")),
      ["sess_pi_held"],
    );

    const counts = finishedCounts(
      await processRefundBatch(
        provider({ refunded: new Set(["pi_held"]) }),
        [candidate([{ reference: "pi_held" }], 11)],
        7,
        {
          claim: refusingRelease,
          markReturned: () => Promise.resolve(),
          record: recordEveryRefund,
        },
      ),
    );

    expect(counts.refundedCount).toBe(1);
    expect(errors.contains("Refund claim could not be released")).toBe(true);
  });
});

describe("admin refund provider > a payment that landed while we waited", () => {
  test("stands the whole run down rather than refunding part of it", async () => {
    const changed: RowClaim = {
      claim: () => Promise.resolve({ kind: "changed" }),
      release: () => Promise.resolve(),
    };
    const asked = provider({ refundCapability: "keyless" });

    const counts = finishedCounts(
      await processRefundBatch(
        asked,
        [candidate([{ reference: "pi_known" }], 11)],
        7,
        { claim: changed, markReturned: () => Promise.resolve() },
      ),
    );

    expect([...asked.reads, ...asked.refunds]).toEqual([]);
    expect(counts.failedCount).toBe(1);
  });
});

describe("admin refund provider > a refund still settling", () => {
  test("retries an inherited keyed claim when no refund is visible", async () => {
    const rowClaim = grantingRowClaim(
      new Map([[42, ["sess_pi_keyed_retry"]]]),
      new Map([[42, "keyed"]]),
    );
    const retryable = provider({
      refundCapability: "keyed",
      refunded: new Set(["pi_keyed_retry"]),
    });

    const counts = finishedCounts(
      await processRefundBatch(
        retryable,
        [candidate([{ reference: "pi_keyed_retry" }])],
        7,
        {
          claim: rowClaim,
          markReturned: () => Promise.resolve(),
          record: recordEveryRefund,
        },
      ),
    );

    expect(retryable.refunds).toEqual(["pi_keyed_retry"]);
    expect(counts.refundedCount).toBe(1);
    expect(rowClaim.released).toEqual([["sess_pi_keyed_retry"]]);
  });

  test("only observes an inherited keyless claim when no refund is visible", async () => {
    const rowClaim = grantingRowClaim(
      new Map([[42, ["sess_pi_invisible"]]]),
      new Map([[42, "keyless"]]),
    );
    const invisible = provider({ refundCapability: "keyless" });

    const counts = finishedCounts(
      await processRefundBatch(
        invisible,
        [candidate([{ reference: "pi_invisible" }])],
        7,
        { claim: rowClaim, markReturned: () => Promise.resolve() },
      ),
    );

    expect(invisible.reads).toEqual(["pi_invisible"]);
    expect(invisible.refunds).toEqual([]);
    expect(counts.pendingCount).toBe(1);
    expect(rowClaim.released).toEqual([]);
  });

  test("a shared keyless charge is observe-only for every holder", async () => {
    const rowClaim = grantingRowClaim(
      new Map([
        [41, ["sess_pi_shared_41"]],
        [42, ["sess_pi_shared_42"]],
      ]),
      new Map([[42, "keyless"]]),
    );
    const shared = provider({ refundCapability: "keyless" });

    const counts = finishedCounts(
      await processRefundBatch(
        shared,
        [
          candidate([{ reference: "pi_shared_invisible" }], 41),
          candidate([{ reference: "pi_shared_invisible" }], 42),
        ],
        7,
        { claim: rowClaim, markReturned: () => Promise.resolve() },
      ),
    );

    expect(shared.reads).toEqual(["pi_shared_invisible"]);
    expect(shared.refunds).toEqual([]);
    expect(counts.pendingCount).toBe(2);
    expect(rowClaim.released).toEqual([]);
  });

  test("keeps an inherited keyless claim while the provider says pending", async () => {
    const rowClaim = grantingRowClaim(
      new Map([[42, ["sess_pi_pending"]]]),
      new Map([[42, "keyless"]]),
    );
    const pending = provider({
      read: () =>
        Promise.resolve(
          chargeMoneyWith({
            refunds: [refundObservation({ status: "pending" })],
          }),
        ),
      refundCapability: "keyed",
    });

    const counts = finishedCounts(
      await processRefundBatch(
        pending,
        [candidate([{ reference: "pi_pending" }])],
        7,
        { claim: rowClaim, markReturned: () => Promise.resolve() },
      ),
    );

    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 0,
      notRecordedCount: 0,
      pendingCount: 1,
      refundedCount: 0,
    });
    expect(rowClaim.released).toEqual([]);
  });

  for (const [name, read] of [
    ["missing", { status: "missing" }],
    ["invalid", { reason: "malformed_response", status: "invalid" }],
  ] as const satisfies readonly [string, ProviderRead<ChargeMoney>][]) {
    test(`keeps an inherited keyless claim when the provider read is ${name}`, async () => {
      const rowClaim = grantingRowClaim(
        new Map([[42, ["sess_pi_unproved"]]]),
        new Map([[42, "keyless"]]),
      );
      const unproved = provider({ refundCapability: "keyed" });
      unproved.readCharge = () => Promise.resolve(read);

      await processRefundBatch(
        unproved,
        [candidate([{ reference: "pi_unproved" }])],
        7,
        { claim: rowClaim, markReturned: () => Promise.resolve() },
      );

      expect(rowClaim.released).toEqual([]);
    });
  }
});

describe("admin refund provider > one charge two attendees carry", () => {
  test("is asked about once in a run, not once per attendee", async () => {
    const shared = provider({
      refundCapability: "keyless",
      refunded: new Set(["pi_both"]),
    });

    const counts = finishedCounts(
      await processRefundBatch(
        shared,
        [
          candidate([{ reference: "pi_both", refundState: "none" }], 11),
          candidate([{ reference: "pi_both", refundState: "none" }], 12),
        ],
        7,
        { claim: grantingRowClaim(), markReturned: () => Promise.resolve() },
      ),
    );

    expect(shared.refunds).toEqual(["pi_both"]);
    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 0,
      notRecordedCount: 2,
      pendingCount: 0,
      refundedCount: 0,
    });
  });
});

describe("admin refund provider > a run that dies holding money", () => {
  test("keeps the hold and raises the failure, rather than swallowing it", async () => {
    const releases: string[] = [];
    const recordsRelease = holdingClaim(() => {
      releases.push("released");
      return Promise.resolve();
    }, ["sess_pi_held"]);

    await expect(
      processRefundBatch(
        provider({ refunded: new Set(["pi_held"]) }),
        [candidate([{ reference: "pi_held" }], 11)],
        7,
        {
          claim: recordsRelease,
          markReturned: () => Promise.resolve(),
          record: () => Promise.reject(new Error("the ledger fell over")),
        },
      ),
    ).rejects.toThrow("the ledger fell over");

    expect(releases).toEqual([]);
  });
});
