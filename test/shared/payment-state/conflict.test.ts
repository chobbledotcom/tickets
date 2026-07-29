import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  IS_THE_READING_ITSELF,
  PaymentConflictSchema,
} from "#shared/payment-state/conflict.ts";

describe("what can be wrong with a payment", () => {
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

  test("refuses a problem with no name at all", () => {
    expect(v.is(PaymentConflictSchema, { kind: "not_a_problem" })).toBe(false);
  });

  test("makes a bad read say what was wrong with it", () => {
    // The other kinds are named by their kind alone; this one carries why.
    expect(v.is(PaymentConflictSchema, { kind: "invalid_provider_data" })).toBe(
      false,
    );
  });

  // The two that mean the read itself failed are the only ones that arrive
  // with nothing to show. Naming them here means a new kind cannot be added
  // without saying which side it falls on.
  test("counts only the two read failures as the reading itself", () => {
    expect(
      Object.entries(IS_THE_READING_ITSELF)
        .filter(([, isRead]) => isRead)
        .map(([kind]) => kind)
        .toSorted(),
    ).toEqual(["invalid_provider_data", "missing_resource"]);
  });

  test("has a say for every problem there is", () => {
    expect(Object.keys(IS_THE_READING_ITSELF).toSorted()).toEqual(
      PaymentConflictSchema.options
        .map((option) => option.entries.kind.literal)
        .toSorted(),
    );
  });
});
