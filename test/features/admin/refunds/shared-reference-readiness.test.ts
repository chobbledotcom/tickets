import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { runRefundReadiness } from "#routes/admin/refunds/readiness-run.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundReference } from "#test-utils/payment-state.ts";

const HELD_SINCE = "2026-08-11T12:00:00.000Z";

describe("admin refund shared-reference readiness", () => {
  const errors = setupErrorSpy();
  test("parks every exact row before preparation", async () => {
    const settlements: RowSettlement[] = [];
    const reference = refundReference("shared_charge", {
      index: "shared_index",
      matchingIndexes: ["shared_index"],
      rowSessionIds: ["shared_first"],
      sessionIds: ["shared_first"],
    });
    const candidate = {
      attendee: { id: 13, pii_blob: "sealed" },
      references: [reference],
    } as RefundCandidate;
    const claim: RowClaim = {
      claim: () =>
        Promise.resolve({
          held: new Map([
            [13, ["shared_first"]],
            [14, ["shared_second"]],
          ]),
          heldSince: HELD_SINCE,
          inherited: new Map(),
          kind: "claimed",
          returned: new Set<string>(),
          reviews: new Map(),
          shared: new Map([
            [
              reference.index,
              [
                {
                  attendeeId: 13,
                  index: reference.index,
                  sessionId: "shared_first",
                },
                {
                  attendeeId: 14,
                  index: reference.index,
                  sessionId: "shared_second",
                },
              ],
            ],
          ]),
          unrecorded: new Map(),
        }),
      settle: (settlement) => {
        settlements.push(settlement);
        return Promise.resolve();
      },
    };
    let prepared = false;
    let ran = false;

    const result = await runRefundReadiness({
      candidates: [candidate],
      changedMessage: "changed",
      claim,
      label: "Refund",
      listingId: 7,
      notReady: (message) => ({ kind: "not_ready" as const, message }),
      prepare: () => {
        prepared = true;
        return Promise.resolve({
          candidates: [],
          capability: "keyed",
          kind: "ready",
        });
      },
      ready: () => {
        ran = true;
        return Promise.resolve({ kind: "ready" as const, message: "" });
      },
    });

    expect(result).toEqual({
      kind: "not_ready",
      message:
        "This payment reference is attached to more than one payment row. An owner must review it before any automatic refund can continue.",
    });
    expect(prepared).toBe(false);
    expect(ran).toBe(false);
    expect(settlements).toEqual([
      {
        heldSince: HELD_SINCE,
        rows: new Map(
          ["shared_first", "shared_second"].map((sessionId) => [
            sessionId,
            {
              claim: "release",
              review: {
                kind: "review",
                reason: { kind: "shared_reference" },
              },
            },
          ]),
        ),
      },
    ]);
    expect(
      errors.contains(
        "This payment reference is attached to more than one payment row",
      ),
    ).toBe(true);
  });
});
