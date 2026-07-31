import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  canChangePaymentSessionState,
  LegacyPaymentChargeSchema,
  LegacyPaymentResourceSchema,
  LegacyPaymentSourceSchema,
  PaymentChargeSchema,
  PaymentCompletionSchema,
  PaymentCompletionStateSchema,
  PaymentResultStateSchema,
  PaymentTicketStateSchema,
  PaymentTicketTokensSchema,
  parsePaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import { PaymentSessionStateSchema } from "#shared/payment-state/lifecycle.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_BOOKING_COMPLETION,
  PAYMENT_PLACEHOLDER_COMPLETION,
  REFUND_RESOURCE,
  sessionProgress,
} from "./fixtures.ts";

const allowed = new Set([
  "completed:completed",
  "completed:refunding",
  "completed:fully_refunded",
  "completed:needs_action",
  "created:created",
  "created:pending",
  "created:ready",
  "created:processing",
  "created:failed",
  "created:needs_action",
  "failed:failed",
  "failed:refunding",
  "failed:fully_refunded",
  "failed:needs_action",
  "fully_refunded:fully_refunded",
  "needs_action:needs_action",
  "needs_action:pending",
  "needs_action:ready",
  "needs_action:processing",
  "needs_action:completed",
  "needs_action:failed",
  "needs_action:refunding",
  "needs_action:fully_refunded",
  "pending:pending",
  "pending:ready",
  "pending:processing",
  "pending:failed",
  "pending:fully_refunded",
  "pending:needs_action",
  "processing:processing",
  "processing:completed",
  "processing:failed",
  "processing:refunding",
  "processing:fully_refunded",
  "processing:needs_action",
  "ready:ready",
  "ready:processing",
  "ready:refunding",
  "ready:fully_refunded",
  "ready:needs_action",
  "refunding:refunding",
  "refunding:fully_refunded",
  "refunding:failed",
  "refunding:needs_action",
]);

test("defines every allowed and forbidden payment session transition", () => {
  for (const from of PaymentSessionStateSchema.options) {
    for (const to of PaymentSessionStateSchema.options) {
      expect(canChangePaymentSessionState(from, to)).toBe(
        allowed.has(`${from}:${to}`),
      );
    }
  }
});

test("requires stored progress data to match each progress state", () => {
  expect(() =>
    parsePaymentSessionProgress(sessionProgress({ resultState: "succeeded" })),
  ).toThrow("Payment result state");
  expect(() =>
    parsePaymentSessionProgress(sessionProgress({ ticketState: "ready" })),
  ).toThrow("Payment ticket state");
  expect(() =>
    parsePaymentSessionProgress(
      sessionProgress({ completionState: "pending" }),
    ),
  ).toThrow("Payment completion state");
  expect(() =>
    parsePaymentSessionProgress(sessionProgress({ session: null })),
  ).toThrow("provider session resource");
  expect(
    parsePaymentSessionProgress(
      sessionProgress({ session: null, state: "created" }),
    ).session,
  ).toBeNull();
  expect(
    parsePaymentSessionProgress(
      sessionProgress({ session: null, state: "failed" }),
    ).session,
  ).toBeNull();
});

test("keeps every stored payment state and non-empty ticket rule exact", () => {
  expect(PaymentResultStateSchema.options).toEqual([
    "none",
    "succeeded",
    "failed",
  ]);
  expect(PaymentTicketStateSchema.options).toEqual([
    "none",
    "ready",
    "consumed",
  ]);
  expect(PaymentCompletionStateSchema.options).toEqual([
    "none",
    "pending",
    "completed",
    "legacy_unknown",
  ]);
  expect(() =>
    parsePaymentSessionProgress(
      sessionProgress({
        completion: PAYMENT_BOOKING_COMPLETION,
        completionState: "legacy_unknown",
      }),
    ),
  ).toThrow("legacy completion state");
  expect(() => v.parse(PaymentTicketTokensSchema, [])).toThrow();
  expect(v.parse(PaymentCompletionSchema, PAYMENT_BOOKING_COMPLETION)).toEqual(
    PAYMENT_BOOKING_COMPLETION,
  );
  expect(
    v.parse(PaymentCompletionSchema, PAYMENT_PLACEHOLDER_COMPLETION),
  ).toEqual(PAYMENT_PLACEHOLDER_COMPLETION);
  expect(() =>
    v.parse(PaymentCompletionSchema, {
      ...PAYMENT_BOOKING_COMPLETION,
      effects: { answers: "pending" },
    }),
  ).toThrow();
});

const storedCharge = {
  captured: { amount: 1_000, currency: "GBP" },
  createdAt: 1,
  id: 1,
  observedAt: 1,
  paymentId: "payment-1",
  pendingRefund: null,
  pendingRefundIdempotencyKey: null,
  providerReference: CHARGE_RESOURCE,
  refunded: { amount: 100, currency: "GBP" },
  refundState: "partial" as const,
  updatedAt: 1,
};

test("rejects inconsistent stored charge money and refund ownership", () => {
  expect(() =>
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      captured: { amount: 0, currency: "GBP" },
      refunded: { amount: 0, currency: "GBP" },
    }),
  ).toThrow("Stored captured money must be positive");
  expect(() =>
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      refunded: { amount: 100, currency: "USD" },
    }),
  ).toThrow("Stored charge money must use one currency");
  expect(() =>
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      refunded: { amount: 1_001, currency: "GBP" },
    }),
  ).toThrow("Stored refunded money cannot exceed captured money");
  expect(() =>
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      pendingRefund: { ...REFUND_RESOURCE, parentId: "other-charge" },
    }),
  ).toThrow("Stored pending refund must belong to its charge");
  expect(() =>
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      pendingRefund: {
        id: "square-refund",
        kind: "square_refund",
        parentId: CHARGE_RESOURCE.id,
        provider: "square",
      },
    }),
  ).toThrow("Stored pending refund must belong to its charge");
  expect(v.parse(PaymentChargeSchema, storedCharge)).toEqual(storedCharge);
});

test("accepts zero timestamps but requires positive stored revisions", () => {
  expect(
    v.parse(PaymentChargeSchema, {
      ...storedCharge,
      captured: { amount: 1, currency: "GBP" },
      createdAt: 0,
      observedAt: 0,
      refunded: { amount: 0, currency: "GBP" },
      updatedAt: 0,
    }),
  ).toMatchObject({
    captured: { amount: 1, currency: "GBP" },
    createdAt: 0,
    refunded: { amount: 0, currency: "GBP" },
  });
  expect(() =>
    v.parse(PaymentChargeSchema, { ...storedCharge, id: 0 }),
  ).toThrow();
});

test("requires exact quarantined legacy charge facts", () => {
  const charge = {
    createdAt: 0,
    id: 1,
    observedAt: 0,
    paymentId: "legacy-payment",
    providerReference: "hyb:1:key:iv:legacy-reference",
    providerRefundedAt: null,
    refundState: "unknown",
    source: "processed_payments" as const,
    updatedAt: 0,
  };
  expect(v.parse(LegacyPaymentChargeSchema, charge)).toEqual(charge);
  expect(() =>
    v.parse(LegacyPaymentChargeSchema, {
      ...charge,
      providerReference: "legacy-reference",
    }),
  ).toThrow();
});

test("keeps every legacy source and its resource kind exact", () => {
  expect(LegacyPaymentSourceSchema.options).toEqual([
    "processed_payments",
    "checkout_stages",
    "sumup_checkouts",
    "attendees.pii_blob",
    "attendee_merge",
  ]);
  expect(
    v.parse(LegacyPaymentResourceSchema, {
      id: "legacy-payment-1",
      kind: "legacy_payment",
      source: "processed_payments",
    }),
  ).toEqual({
    id: "legacy-payment-1",
    kind: "legacy_payment",
    source: "processed_payments",
  });
});
