import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentCaseStateSchema,
  PaymentConflictSchema,
  PaymentIgnoreReasonSchema,
  PaymentPendingReasonSchema,
  PaymentRefundStateSchema,
  PaymentResolutionSchema,
  PaymentSessionStateSchema,
} from "#shared/payment-state/lifecycle.ts";
import {
  chargeLeg,
  noPaymentRequiredObservation,
  paymentObservation,
  refundedObservation,
  refundObservation,
  sessionResource,
} from "./fixtures.ts";

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
      {
        observation: paymentObservation({ status: "pending" }),
        reason: "payment_pending",
        status: "pending",
      },
      { observation: refundedObservation(), status: "fully_refunded" },
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

  test("refuses a fully refunded payment with money still held", () => {
    // The charge gave back only half, so the money is not finally returned.
    const observation = paymentObservation({
      charges: [
        chargeLeg({ confirmedRefunded: { amount: 50, currency: "GBP" } }),
      ],
    });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("refuses a fully refunded payment that never took any money", () => {
    // With no charge there is nothing to have given back.
    const observation = paymentObservation({ charges: undefined });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("refuses a fully refunded payment holding money on a second charge", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({ confirmedRefunded: { amount: 100, currency: "GBP" } }),
        chargeLeg(),
      ],
    });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("accepts a payment waiting on a refund that is really going", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({ refunds: [refundObservation({ status: "pending" })] }),
      ],
    });

    expect(
      v.parse(PaymentResolutionSchema, {
        observation,
        reason: "refund_pending",
        status: "pending",
      }).status,
    ).toBe("pending");
  });

  test("refuses a payment waiting on a refund with nothing in flight", () => {
    // Nothing to find on the next look, so it would be looked at forever.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation: paymentObservation(),
        reason: "refund_pending",
        status: "pending",
      }),
    ).toThrow();
  });

  for (const [reason, status] of [
    ["payment_pending", "paid"],
    ["refund_pending", "pending"],
  ] as const) {
    test(`refuses ${reason} beside a reading that says ${status}`, () => {
      expect(() =>
        v.parse(PaymentResolutionSchema, {
          observation: paymentObservation({ status }),
          reason,
          status: "pending",
        }),
      ).toThrow();
    });
  }

  test("refuses a problem that names a different checkout to its evidence", () => {
    // The problem would send a worker, or the owner, to the wrong payment.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        issue: { kind: "partial_refund" },
        observation: paymentObservation(),
        resource: { ...sessionResource, id: "another_checkout" },
        status: "conflict",
      }),
    ).toThrow();
  });

  test("counts a checkout that needed no money as ready", () => {
    const observation = noPaymentRequiredObservation();

    expect(
      v.parse(PaymentResolutionSchema, { observation, status: "ready" }).status,
    ).toBe("ready");
  });

  for (const status of ["pending", "failed"] as const) {
    test(`refuses a ready payment whose reading is ${status}`, () => {
      const observation = paymentObservation({ status });

      expect(() =>
        v.parse(PaymentResolutionSchema, { observation, status: "ready" }),
      ).toThrow();
    });
  }

  test("refuses a ready payment that needed no money but took some", () => {
    const observation = paymentObservation({ status: "no_payment_required" });

    expect(() =>
      v.parse(PaymentResolutionSchema, { observation, status: "ready" }),
    ).toThrow();
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
});
