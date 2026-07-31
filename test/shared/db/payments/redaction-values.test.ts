import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  redactBookingIntent,
  redactPaymentCaseEvidence,
  redactPaymentCompletion,
  redactPaymentResolution,
} from "#shared/db/payments/redaction-values.ts";
import {
  chargeLeg,
  PAYMENT_COMPLETED_BOOKING,
  PAYMENT_INTENT,
  PAYMENT_PLACEHOLDER_COMPLETION,
  READY_RESULT,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";

const REDACTED_INTENT = {
  address: "",
  date: null,
  email: "",
  items: PAYMENT_INTENT.items,
  modifiers: [],
  name: "",
  phone: "",
  special_instructions: "",
};

describe("payment redaction values", () => {
  test("keeps booking lines while removing contact and optional metadata", () => {
    expect(
      redactBookingIntent({
        ...PAYMENT_INTENT,
        listingAnswerIds: { "7": [3] },
        thankYouUrl: "https://private.example/thanks",
      }),
    ).toEqual(REDACTED_INTENT);
  });

  test("redacts booking and placeholder completion plans", () => {
    const booking = redactPaymentCompletion({
      ...PAYMENT_COMPLETED_BOOKING,
      facts: {
        ...PAYMENT_COMPLETED_BOOKING.facts,
        promos: [{ delta: -10, modifierId: 3, name: "Secret promo" }],
      },
    });
    const placeholder = redactPaymentCompletion(PAYMENT_PLACEHOLDER_COMPLETION);

    expect(booking).toMatchObject({
      facts: { promos: [{ delta: -10, modifierId: 3, name: "" }] },
      input: REDACTED_INTENT,
    });
    expect(placeholder).toMatchObject({
      facts: {
        spec: { code: "price_changed", detail: "", reason: "" },
      },
      input: REDACTED_INTENT,
    });
  });

  test("redacts observations while preserving provider and money facts", () => {
    const withRefund = {
      ...READY_RESULT,
      observation: {
        ...READY_RESULT.observation,
        charges: [
          chargeLeg(1_000, [
            {
              amount: { amount: 1_000, currency: "GBP" },
              refund: REFUND_RESOURCE,
              status: "completed",
            },
          ]),
        ],
      },
    };
    const resolution = redactPaymentResolution(withRefund);
    if (!("observation" in resolution)) {
      throw new Error("Expected redacted provider observation");
    }
    expect(resolution.observation).toMatchObject({
      bookingIntent: REDACTED_INTENT,
      charges: withRefund.observation.charges,
      providerTotal: { amount: 1_000, currency: "GBP" },
      session: SESSION_RESOURCE,
    });
  });

  test("leaves a resolution without provider evidence unchanged", () => {
    const retry = {
      reason: "timed_out" as const,
      resource: SESSION_RESOURCE,
      status: "retry" as const,
    };
    expect(redactPaymentResolution(retry)).toEqual(retry);
  });

  test("redacts found case reads and preserves evidence without PII", () => {
    const found = redactPaymentCaseEvidence({
      kind: "provider_read",
      read: {
        observation: READY_RESULT.observation,
        requested: SESSION_RESOURCE,
        returned: SESSION_RESOURCE,
        status: "found",
      },
    });
    const legacy = {
      fact: "provider" as const,
      legacyPaymentId: "legacy-payment",
      providerRefundedAt: "",
      source: "processed_payments" as const,
    };

    expect(found).toMatchObject({
      read: { observation: { bookingIntent: REDACTED_INTENT } },
    });
    expect(redactPaymentCaseEvidence(legacy)).toBe(legacy);
  });

  test("keeps unavailable case reads unchanged", () => {
    const evidence = {
      kind: "provider_read" as const,
      read: {
        reason: "timed_out" as const,
        requested: SESSION_RESOURCE,
        status: "unavailable" as const,
      },
    };
    expect(redactPaymentCaseEvidence(evidence)).toEqual(evidence);
  });
});
