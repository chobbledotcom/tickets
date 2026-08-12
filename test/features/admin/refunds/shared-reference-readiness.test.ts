import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { runRefundReadiness } from "#routes/admin/refunds/readiness-run.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundReference } from "#test-utils/payment-state.ts";

const HELD_SINCE = "2026-08-11T12:00:00.000Z";

type ReadinessRunResult =
  | { kind: "not_ready"; message: string }
  | { kind: "ready"; message: string };

type Claimed = Extract<
  Awaited<ReturnType<RowClaim["claim"]>>,
  { kind: "claimed" }
>;

const recordingClaim = (
  facts: Pick<Claimed, "held" | "reviews" | "shared">,
): { readonly claim: RowClaim; readonly settlements: RowSettlement[] } => {
  const settlements: RowSettlement[] = [];
  return {
    claim: {
      claim: () =>
        Promise.resolve({
          commandId: "test-command",
          heldSince: HELD_SINCE,
          inherited: new Map(),
          kind: "claimed",
          phases: new Map(
            [...facts.held.values()].flat().map((sessionId) => [
              sessionId,
              "checking" as const,
            ]),
          ),
          returned: new Set<string>(),
          reviews: facts.reviews,
          shared: facts.shared,
          unrecorded: new Map(),
          held: facts.held,
        }),
      settle: (settlement) => {
        settlements.push(settlement);
        return Promise.resolve();
      },
    },
    settlements,
  };
};

describe("admin refund shared-reference readiness", () => {
  const errors = setupErrorSpy();
  test("parks every exact row before preparation", async () => {
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
    const runClaim = recordingClaim({
      held: new Map([
        [13, ["shared_first"]],
        [14, ["shared_second"]],
      ]),
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
    });
    let prepared = false;
    let ran = false;

    const result = await runRefundReadiness<ReadinessRunResult>({
      action: "refund",
      candidates: [candidate],
      changedMessage: "changed",
      claim: runClaim.claim,
      label: "Refund",
      listingId: 7,
      notReady: (message) => ({ kind: "not_ready" as const, message }),
      prepare: () => {
        prepared = true;
        return Promise.resolve({
          candidates: [],
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
    expect(runClaim.settlements).toEqual([
      {
        commandId: "test-command",
        heldSince: HELD_SINCE,
        rows: new Map(
          ["shared_first", "shared_second"].map((sessionId) => [
            sessionId,
            {
              claim: "release",
              phase: "checking",
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

  test("retires a shared-reference review once the exact index is unique", async () => {
    const reference = refundReference("unique_charge", {
      index: "unique_index",
      matchingIndexes: ["unique_index"],
      rowSessionIds: ["unique_row"],
      sessionIds: ["unique_row"],
    });
    const candidate = {
      attendee: { id: 15, pii_blob: "sealed" },
      references: [reference],
    } as RefundCandidate;
    const runClaim = recordingClaim({
      held: new Map([[15, ["unique_row"]]]),
      reviews: new Map([["unique_row", { kind: "shared_reference" }]]),
      shared: new Map(),
    });

    const result = await runRefundReadiness<ReadinessRunResult>({
      action: "refund",
      candidates: [candidate],
      changedMessage: "changed",
      claim: runClaim.claim,
      label: "Refund",
      listingId: 7,
      notReady: (message) => ({ kind: "not_ready", message }),
      prepare: () =>
        Promise.resolve({
          indexes: [reference.index],
          kind: "not_ready",
          reason: "historical_marker",
        }),
      ready: () => Promise.resolve({ kind: "ready", message: "" }),
    });

    expect(result.kind).toBe("not_ready");
    expect(runClaim.settlements).toEqual([
      {
        commandId: "test-command",
        heldSince: HELD_SINCE,
        rows: new Map([
          [
            "unique_row",
            {
              claim: "release",
              phase: "checking",
              review: { kind: "resolved", reason: "shared_reference" },
            },
          ],
        ]),
      },
    ]);
  });
});
