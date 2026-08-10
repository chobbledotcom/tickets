import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { PaymentConflictSchema } from "#shared/payment/conflict.ts";

describe("what can be wrong with a payment", () => {
  test("validates every payment conflict", () => {
    const conflicts = [
      { kind: "resource_mismatch" },
      { kind: "currency_mismatch" },
      { kind: "provider_total_mismatch" },
      { kind: "partial_charge" },
      { kind: "capture_total_mismatch" },
      { kind: "refund_exceeds_capture" },
      { kind: "duplicate_charge" },
      { kind: "multiple_charges" },
      { kind: "paid_without_charge" },
      { kind: "partial_refund" },
      { kind: "failed_refund" },
    ] as const;

    expect(
      conflicts.map((item) => v.parse(PaymentConflictSchema, item).kind),
    ).toEqual(conflicts.map((item) => item.kind));
  });

  test("refuses a problem with no name at all", () => {
    expect(v.is(PaymentConflictSchema, { kind: "not_a_problem" })).toBe(false);
  });

  // The four reference kinds a later milestone brings back must not be
  // accepted early: the read-level pair belongs to M5's stored-answer
  // re-validation and the refund-shape pair to M7's per-refund records.
  for (const kind of [
    "invalid_provider_data",
    "missing_resource",
    "duplicate_refund",
    "multiple_pending_refunds",
  ] as const) {
    test(`does not yet know ${kind}`, () => {
      expect(v.is(PaymentConflictSchema, { kind })).toBe(false);
    });
  }
});
