import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { runRefundReadiness } from "#routes/admin/refunds/readiness-run.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import {
  candidate,
  untagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const ATTENDEE_ID = 23;
const COMMAND_ID = "admission-command";
const HELD_SINCE = "2026-08-12T12:00:00.000Z";
const ROW_SESSION_ID = "session_admission";
const REFERENCE = untagged("admission", "admission");
const CANDIDATE = candidate(ATTENDEE_ID, [REFERENCE]);

type SafetyState = {
  readonly diagnosticReason: "owner_review" | "unrecorded_money";
  readonly name: string;
  readonly refundMessage: string;
  readonly reviews: ReadonlyMap<string, PaymentReviewReason>;
  readonly unrecorded: ReadonlyMap<number, readonly string[]>;
};

const SAFETY_STATES = [
  {
    diagnosticReason: "owner_review",
    name: "owner review",
    refundMessage:
      "This payment still needs owner review. Refresh or correct the payment evidence before another refund.",
    reviews: new Map([[ROW_SESSION_ID, { kind: "partial_refund" } as const]]),
    unrecorded: new Map(),
  },
  {
    diagnosticReason: "unrecorded_money",
    name: "unrecorded returned money",
    refundMessage:
      "This returned payment is not recorded in Money yet. Refresh the payment status before another refund.",
    reviews: new Map(),
    unrecorded: new Map([[ATTENDEE_ID, [ROW_SESSION_ID]]]),
  },
] satisfies readonly SafetyState[];

type RunResult =
  | { readonly kind: "not_ready"; readonly message: string }
  | { readonly kind: "ready"; readonly message: string };

const recordingClaim = (
  state: SafetyState,
): { readonly claim: RowClaim; readonly settlements: RowSettlement[] } => {
  const settlements: RowSettlement[] = [];
  return {
    claim: {
      claim: () =>
        Promise.resolve({
          commandId: COMMAND_ID,
          held: new Map([[ATTENDEE_ID, [ROW_SESSION_ID]]]),
          heldSince: HELD_SINCE,
          kind: "claimed" as const,
          phases: new Map([[ROW_SESSION_ID, "checking" as const]]),
          returned: new Set<string>(),
          reviews: state.reviews,
          shared: new Map(),
          unrecorded: state.unrecorded,
        }),
      settle: (settlement) => {
        settlements.push(settlement);
        return Promise.resolve();
      },
    },
    settlements,
  };
};

const runFor = async (
  action: "refund" | "refresh",
  state: SafetyState,
): Promise<{
  readonly calls: { readonly prepare: number; readonly ready: number };
  readonly result:
    | RunResult
    | {
      kind: "blocked";
      reason: "refund_in_progress";
    };
  readonly settlements: RowSettlement[];
}> => {
  const recorded = recordingClaim(state);
  const calls = { prepare: 0, ready: 0 };
  const common = {
    candidates: [CANDIDATE],
    changedMessage: "the loaded payment changed",
    claim: recorded.claim,
    listingId: 7,
    notReady: (message: string): RunResult => ({
      kind: "not_ready",
      message,
    }),
    prepare: () => {
      calls.prepare++;
      return Promise.resolve({ candidates: [], kind: "ready" as const });
    },
    ready: (): Promise<RunResult> => {
      calls.ready++;
      return Promise.resolve({
        kind: "ready",
        message: `Refresh prepared ${state.name}`,
      });
    },
  };
  const run = action === "refund"
    ? { ...common, action, budgetAudience: "bulk" as const }
    : { ...common, action };
  const result = await runRefundReadiness<RunResult>(run);
  return { calls, result, settlements: recorded.settlements };
};

const releasedWithoutChangingSafetyState = (): RowSettlement => ({
  commandId: COMMAND_ID,
  heldSince: HELD_SINCE,
  rows: new Map([
    [ROW_SESSION_ID, { claim: "release", phase: "checking" }],
  ]),
});

describe("refund readiness action admission", () => {
  const errors = setupErrorSpy();

  test("reports every attendee when the claimed payment set changed", async () => {
    const result = await runRefundReadiness<RunResult>({
      action: "refresh",
      candidates: [CANDIDATE],
      changedMessage: "the loaded payment changed",
      claim: {
        claim: () => Promise.resolve({ kind: "changed" }),
        settle: () => Promise.reject(new Error("No rows were claimed")),
      },
      listingId: 7,
      notReady: (message) => ({ kind: "not_ready", message }),
      prepare: () => {
        throw new Error("Changed rows reached provider preparation");
      },
      ready: () => {
        throw new Error("Changed rows reached ready work");
      },
    });

    expect(result).toEqual({
      kind: "not_ready",
      message: "the loaded payment changed",
    });
    expect(
      errors.contains("Admin refresh not started (payment_set_changed)"),
    ).toBe(true);
  });

  for (const state of SAFETY_STATES) {
    test(`a refund stops before preparation for ${state.name}`, async () => {
      const run = await runFor("refund", state);

      expect(run.result).toEqual({
        kind: "not_ready",
        message: state.refundMessage,
      });
      expect(run.calls).toEqual({ prepare: 0, ready: 0 });
      expect(run.settlements).toEqual([
        releasedWithoutChangingSafetyState(),
      ]);
      expect(
        errors.contains(`Admin refund not started (${state.diagnosticReason})`),
      ).toBe(true);
    });

    test(`a refresh may prepare ${state.name}`, async () => {
      const run = await runFor("refresh", state);

      expect(run.result).toEqual({
        kind: "ready",
        message: `Refresh prepared ${state.name}`,
      });
      expect(run.calls).toEqual({ prepare: 1, ready: 1 });
      expect(run.settlements).toEqual([
        releasedWithoutChangingSafetyState(),
      ]);
      expect(errors.calls).toEqual([]);
    });
  }
});
