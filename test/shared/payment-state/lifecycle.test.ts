import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentCaseStateSchema,
  PaymentChargeDecisionSnapshotSchema,
  PaymentConflictSchema,
  PaymentIgnoreReasonSchema,
  PaymentLegacyDecisionSnapshotSchema,
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
    // "unknown" is what a charge copied from an older version carries: the old
    // record never said what happened to its refund. The table demands it for
    // those rows, so the words for a refund state have to include it or a
    // copied charge could not be read back at all.
    expect(PaymentRefundStateSchema.options).toEqual([
      "none",
      "requested",
      "pending",
      "partial",
      "completed",
      "failed",
      "unknown",
    ]);
  });

  test("refuses reviewed money taken by another provider", () => {
    // The worker acts through the provider the decision names, so being shown
    // another provider's money would have it act on the wrong account.
    expect(
      v.safeParse(PaymentChargeDecisionSnapshotSchema, {
        accountId: "acct_1",
        charges: [
          {
            captured: { amount: 100, currency: "GBP" },
            chargeId: 1,
            providerReference: {
              id: "sq_1",
              kind: "square_payment",
              parentId: "order_1",
              provider: "square",
            },
            refunded: { amount: 0, currency: "GBP" },
          },
        ],
        kind: "charges",
        mode: "test",
        paymentId: "pay_1",
        provider: "stripe",
      }).success,
    ).toBe(false);
  });

  const chargeSnapshot = (charges: unknown[]) => ({
    accountId: "acct_1",
    charges,
    kind: "charges",
    mode: "test",
    paymentId: "pay_1",
    provider: "stripe",
  });

  const reviewedCharge = {
    captured: { amount: 100, currency: "GBP" },
    chargeId: 1,
    providerReference: {
      id: "pi_1",
      kind: "stripe_payment_intent",
      parentId: "cs_1",
      provider: "stripe",
    },
    refunded: { amount: 0, currency: "GBP" },
  };

  for (const [name, broken] of [
    [
      "returned beyond what was taken",
      { refunded: { amount: 101, currency: "GBP" } },
    ],
    [
      "returned in another currency",
      { refunded: { amount: 0, currency: "USD" } },
    ],
    // A charge row must hold at least a penny, so a review of nothing shows
    // the worker money that could never be saved as the charge it names.
    ["no money taken at all", { captured: { amount: 0, currency: "GBP" } }],
  ] as const) {
    test(`refuses reviewed money ${name}`, () => {
      expect(
        v.safeParse(
          PaymentChargeDecisionSnapshotSchema,
          chargeSnapshot([{ ...reviewedCharge, ...broken }]),
        ).success,
      ).toBe(false);
    });
  }

  test("refuses the same money listed twice in a review", () => {
    // Listed twice, it would be offered to the worker twice.
    expect(
      v.safeParse(
        PaymentChargeDecisionSnapshotSchema,
        chargeSnapshot([reviewedCharge, reviewedCharge]),
      ).success,
    ).toBe(false);
  });

  // An old payment's review names its money as plain text, so the same two
  // holes have to be closed there as well.
  for (const [name, charges] of [
    [
      "lists the same money twice",
      [
        { chargeId: 1, providerReference: "ch_old" },
        { chargeId: 1, providerReference: "ch_old" },
      ],
    ],
    [
      "names money with only spaces",
      [{ chargeId: 1, providerReference: "   " }],
    ],
  ] as const) {
    test(`refuses an old payment's review that ${name}`, () => {
      expect(
        v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
          charges,
          kind: "legacy_assignment",
          paymentId: "pay_1",
        }).success,
      ).toBe(false);
    });
  }

  test("accepts an old payment's review naming distinct money", () => {
    expect(
      v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
        charges: [
          { chargeId: 1, providerReference: "ch_old" },
          { chargeId: 2, providerReference: "ch_older" },
        ],
        kind: "legacy_assignment",
        paymentId: "pay_1",
      }).success,
    ).toBe(true);
  });

  test("refuses giving a payment one provider while showing another's money", () => {
    // The owner is saying which provider took this old payment, so being shown
    // a different provider's checkout would attach the wrong money.
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        accountId: "acct_1",
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "assign_provider",
        mode: "test",
        provider: "square",
        read: {
          captured: { amount: 100, currency: "GBP" },
          charge: {
            id: "pi_1",
            kind: "stripe_payment_intent",
            parentId: "cs_1",
            provider: "stripe",
          },
          refunded: { amount: 0, currency: "GBP" },
          session: {
            id: "cs_1",
            kind: "stripe_checkout_session",
            provider: "stripe",
          },
          status: "attached",
        },
        reason: "It was Stripe",
      }).success,
    ).toBe(false);
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
