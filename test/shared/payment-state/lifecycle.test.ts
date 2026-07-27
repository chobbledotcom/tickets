import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentCaseStateSchema,
  PaymentConflictSchema,
  PaymentIgnoreReasonSchema,
  PaymentOperatorDecisionSchema,
  PaymentPendingReasonSchema,
  PaymentRefundStateSchema,
  PaymentResolutionSchema,
  PaymentSessionStateSchema,
} from "#shared/payment-state/lifecycle.ts";
import { paymentObservation, sessionResource } from "./fixtures.ts";

describe("payment lifecycle", () => {
  test("validates every payment conflict", () => {
    const conflicts = [
      { kind: "invalid_provider_data", reason: "mismatched_id" },
      { kind: "missing_resource" },
      { kind: "resource_mismatch" },
      { kind: "currency_mismatch" },
      { kind: "provider_total_mismatch" },
      { kind: "partial_charge" },
      { kind: "capture_total_mismatch" },
      { kind: "refund_exceeds_capture" },
      { kind: "duplicate_charge" },
      { kind: "multiple_charges" },
      { kind: "duplicate_refund" },
      { kind: "multiple_pending_refunds" },
      { kind: "paid_without_charge" },
      { kind: "partial_refund" },
      { kind: "failed_refund" },
    ] as const;

    expect(
      conflicts.map((item) => v.parse(PaymentConflictSchema, item).kind),
    ).toEqual(conflicts.map((item) => item.kind));
  });

  test("validates every payment resolution", () => {
    const observation = paymentObservation();
    const resolutions = [
      { observation, status: "ready" },
      { observation, reason: "payment_pending", status: "pending" },
      { observation, status: "fully_refunded" },
      { reason: "timed_out", resource: sessionResource, status: "retry" },
      {
        issue: { kind: "partial_refund" },
        observation,
        resource: sessionResource,
        status: "conflict",
      },
      { reason: "not_ours", resource: sessionResource, status: "ignore" },
    ] as const;
    expect(
      resolutions.map((item) => v.parse(PaymentResolutionSchema, item).status),
    ).toEqual([
      "ready",
      "pending",
      "fully_refunded",
      "retry",
      "conflict",
      "ignore",
    ]);
  });

  test("defines every pending and ignore reason", () => {
    expect(PaymentPendingReasonSchema.options).toEqual([
      "payment_pending",
      "refund_pending",
    ]);
    expect(PaymentIgnoreReasonSchema.options).toEqual([
      "not_ours",
      "payment_failed",
      "unproven_invalid_data",
      "unproven_missing_resource",
    ]);
  });

  test("defines durable session, case, and refund states", () => {
    expect(PaymentSessionStateSchema.options).toEqual([
      "created",
      "pending",
      "ready",
      "processing",
      "completed",
      "failed",
      "refunding",
      "fully_refunded",
      "needs_action",
    ]);
    expect(PaymentCaseStateSchema.options).toEqual([
      "retrying",
      "needs_action",
      "resolved",
    ]);
    expect(PaymentRefundStateSchema.options).toEqual([
      "none",
      "requested",
      "pending",
      "partial",
      "completed",
      "failed",
    ]);
  });

  test("requires a reason, actor, and current case revision for decisions", () => {
    const base = {
      actorId: 1,
      caseRevision: 1,
      decidedAt: 1_785_024_000_000,
      reason: "Provider evidence checked",
    };
    const decisions = [
      { ...base, kind: "complete_booking" },
      { ...base, kind: "refund_remaining" },
      {
        ...base,
        charges: [
          { captured: { amount: 1_000, currency: "GBP" }, chargeId: 1 },
        ],
        kind: "confirm_fully_refunded",
      },
      {
        ...base,
        accountId: "account_1",
        kind: "assign_provider",
        mode: "live",
        provider: "square",
        read: { status: "missing" },
      },
    ] as const;
    expect(
      decisions.map(
        (item) => v.parse(PaymentOperatorDecisionSchema, item).kind,
      ),
    ).toEqual([
      "complete_booking",
      "refund_remaining",
      "confirm_fully_refunded",
      "assign_provider",
    ]);
  });

  for (const [name, decision] of [
    [
      "generic dismissal",
      {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "dismiss",
        reason: "Ignore it",
      },
    ],
    [
      "stale revision",
      {
        actorId: 1,
        caseRevision: 0,
        decidedAt: 1,
        kind: "refund_remaining",
        reason: "Refund it",
      },
    ],
    [
      "empty reason",
      {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "complete_booking",
        reason: "",
      },
    ],
  ] as const) {
    test(`rejects an operator decision with ${name}`, () => {
      expect(v.safeParse(PaymentOperatorDecisionSchema, decision).success).toBe(
        false,
      );
    });
  }
});
