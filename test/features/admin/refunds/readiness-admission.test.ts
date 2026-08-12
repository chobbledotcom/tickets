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
  readonly name: string;
  readonly refundMessage: string;
  readonly reviews: ReadonlyMap<string, PaymentReviewReason>;
  readonly unrecorded: ReadonlyMap<number, readonly string[]>;
};

const SAFETY_STATES = [
  {
    name: "owner review",
    refundMessage:
      "This payment still needs owner review. Refresh or correct the payment evidence before another refund.",
    reviews: new Map([[ROW_SESSION_ID, { kind: "partial_refund" } as const]]),
    unrecorded: new Map(),
  },
  {
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
          inherited: new Map(),
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
  const result = await runRefundReadiness<RunResult>({
    action,
    candidates: [CANDIDATE],
    changedMessage: "the loaded payment changed",
    claim: recorded.claim,
    label: action === "refund" ? "Refund" : "Refresh",
    listingId: 7,
    notReady: (message) => ({ kind: "not_ready", message }),
    prepare: () => {
      calls.prepare++;
      return Promise.resolve({ candidates: [], kind: "ready" });
    },
    ready: () => {
      calls.ready++;
      return Promise.resolve({
        kind: "ready",
        message: `Refresh prepared ${state.name}`,
      });
    },
  });
  return { calls, result, settlements: recorded.settlements };
};

const releasedWithoutChangingSafetyState = (
  phase: "checking" | "ready",
): RowSettlement => ({
  commandId: COMMAND_ID,
  heldSince: HELD_SINCE,
  rows: new Map([[ROW_SESSION_ID, { claim: "release", phase }]]),
});

describe("refund readiness action admission", () => {
  const errors = setupErrorSpy();

  for (const state of SAFETY_STATES) {
    test(`a refund stops before preparation for ${state.name}`, async () => {
      const run = await runFor("refund", state);

      expect(run.result).toEqual({
        kind: "not_ready",
        message: state.refundMessage,
      });
      expect(run.calls).toEqual({ prepare: 0, ready: 0 });
      expect(run.settlements).toEqual([
        releasedWithoutChangingSafetyState("checking"),
      ]);
      expect(
        errors.contains(
          `Refund not started for attendee ${ATTENDEE_ID}: ${state.refundMessage}`,
        ),
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
        releasedWithoutChangingSafetyState("ready"),
      ]);
      expect(errors.calls).toEqual([]);
    });
  }
});
