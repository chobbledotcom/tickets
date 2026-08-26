import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  acknowledgePaymentReview,
  openPaymentReview,
  PAYMENT_REVIEW_RETIREMENT,
  PaymentReviewCaseSchema,
  type PaymentReviewReason,
  PaymentReviewReasonSchema,
} from "#payment/review.ts";

const REASONS = Object.keys(
  PAYMENT_REVIEW_RETIREMENT,
) as PaymentReviewReason["kind"][];

const SEEN_AT = "2026-05-01T09:00:00Z";

const SHARED_REFERENCE = { kind: "shared_reference" } as const;

describe("a payment disagreement an owner must look at", () => {
  test("names the evidence that retires each kind", () => {
    expect(PAYMENT_REVIEW_RETIREMENT).toEqual({
      partially_returned_obligation: "all_returned_and_recorded",
      shared_reference: "unique_reference",
    });
  });

  for (const kind of REASONS) {
    test(`opens a ${kind} case nobody has seen yet`, () => {
      expect(openPaymentReview({ kind })).toEqual({
        caseId: expect.any(String),
        reason: { kind },
      });
    });
  }

  // A later disagreement is its own case, so an owner's form cannot
  // acknowledge one that was opened after they loaded the page.
  test("gives every case its own id", () => {
    const first = openPaymentReview(SHARED_REFERENCE);
    const second = openPaymentReview(SHARED_REFERENCE);
    expect(first.caseId).not.toBe(second.caseId);
  });

  test("keeps the case whole when the owner acknowledges it", () => {
    const open = openPaymentReview(SHARED_REFERENCE);
    expect(acknowledgePaymentReview(open, SEEN_AT)).toEqual({
      acknowledgedAt: SEEN_AT,
      caseId: open.caseId,
      reason: SHARED_REFERENCE,
    });
  });

  test("stores a case the module opened and acknowledged", () => {
    const seen = acknowledgePaymentReview(
      openPaymentReview(SHARED_REFERENCE),
      SEEN_AT,
    );
    expect(v.parse(PaymentReviewCaseSchema, seen)).toEqual(seen);
  });

  for (const kind of REASONS) {
    test(`stores ${kind} as a reason`, () => {
      expect(v.parse(PaymentReviewReasonSchema, { kind })).toEqual({ kind });
    });
  }

  for (const [name, stored] of [
    ["names no reason we know", { caseId: "c_1", reason: { kind: "wat" } }],
    ["carries no case id", { caseId: "", reason: SHARED_REFERENCE }],
    [
      "was acknowledged at no time",
      { acknowledgedAt: "", caseId: "c_1", reason: SHARED_REFERENCE },
    ],
    [
      "carries a field we never wrote",
      { caseId: "c_1", note: "hello", reason: SHARED_REFERENCE },
    ],
  ] as const) {
    test(`refuses a stored case that ${name}`, () => {
      expect(v.safeParse(PaymentReviewCaseSchema, stored).success).toBe(false);
    });
  }
});
