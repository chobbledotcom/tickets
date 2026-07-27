import type {
  PaymentFacts,
  ProviderInvalidReason,
} from "#shared/payment-state/observation.ts";

const orderedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );

export const storedPaymentFacts = (payment: PaymentFacts): PaymentFacts => ({
  accountId: payment.accountId,
  bookingIntent: payment.bookingIntent,
  expected: payment.expected,
  mode: payment.mode,
});

type StoredPaymentFactIssue = Extract<
  ProviderInvalidReason,
  "malformed_response" | "mismatched_account"
>;

export const storedPaymentFactIssue = (
  payment: PaymentFacts,
  observed: PaymentFacts,
): StoredPaymentFactIssue | null => {
  if (payment.accountId !== observed.accountId) return "mismatched_account";
  const stored = storedPaymentFacts(payment);
  return orderedJson({
    bookingIntent: stored.bookingIntent,
    expected: stored.expected,
    mode: stored.mode,
  }) ===
    orderedJson({
      bookingIntent: observed.bookingIntent,
      expected: observed.expected,
      mode: observed.mode,
    })
    ? null
    : "malformed_response";
};
