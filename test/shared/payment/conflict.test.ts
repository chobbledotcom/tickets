import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { PaymentConflictSchema } from "#shared/payment/conflict.ts";

describe("what can be wrong with a payment", () => {
  test("validates every payment conflict", () => {
    const conflicts = [
      { kind: "multiple_pending_refunds" },
      { kind: "refund_exceeds_capture" },
      { kind: "partial_refund" },
    ] as const;

    expect(
      conflicts.map((item) => v.parse(PaymentConflictSchema, item).kind),
    ).toEqual(conflicts.map((item) => item.kind));
  });

  test("refuses a problem with no name at all", () => {
    expect(v.is(PaymentConflictSchema, { kind: "not_a_problem" })).toBe(false);
  });

  // Nothing can report these yet, so nothing may store one either. The first
  // eight need a whole reading of the checkout to compare money against what
  // was owed; the last four belong to later milestones — the read-level pair
  // to M5's stored-answer re-validation, the refund-shape pair to M7's
  // per-refund records.
  for (const kind of [
    "resource_mismatch",
    "currency_mismatch",
    "provider_total_mismatch",
    "partial_charge",
    "capture_total_mismatch",
    "duplicate_charge",
    "multiple_charges",
    "paid_without_charge",
    "invalid_provider_data",
    "missing_resource",
    "duplicate_refund",
  ] as const) {
    test(`does not yet know ${kind}`, () => {
      expect(v.is(PaymentConflictSchema, { kind })).toBe(false);
    });
  }
});
