import type {
  PaymentSessionCreate,
  PaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import {
  bookingCompletion,
  type PlaceholderRefundCompletion,
  placeholderRefundCompletion,
} from "#shared/payment-completion.ts";
import type {
  PaymentChargeDecisionSnapshot,
  PaymentResolution,
} from "#shared/payment-state/lifecycle.ts";
import type {
  ChargeLeg,
  ProviderChargeResource,
  ProviderRefundResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";

export const PAYMENT_ID = "local-payment-1";
export const PAYMENT_TIME = 1_785_024_000_000;
export const PAYMENT_INTENT = {
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [{ e: 7, p: 1_000, q: 1 }],
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

export const PAYMENT_BOOKING_COMPLETION = bookingCompletion(
  PAYMENT_INTENT,
  {
    flow: "registration",
    listingId: 7,
    occurredAt: "2026-07-26T12:00:00.000Z",
    promos: [],
  },
  ["ticket-one"],
);

export const PAYMENT_COMPLETED_BOOKING = {
  ...PAYMENT_BOOKING_COMPLETION,
  effects: {
    answers: "completed",
    balance_activity: "completed",
    external_deliveries: "completed",
    external_delivery_setup: "completed",
    promo_activity: "completed",
    registration_activity: "completed",
  },
} as const;

export const PAYMENT_PLACEHOLDER_RESULT = {
  detail: "The price changed",
  error: "We saved your booking details.",
  refund: {
    amount: { amount: 1_000, currency: "GBP" },
    status: "completed",
  },
  status: 200,
  success: false,
} satisfies PlaceholderRefundCompletion["result"];

export const PAYMENT_PLACEHOLDER_COMPLETION = placeholderRefundCompletion(
  PAYMENT_INTENT,
  {
    amount: 1_000,
    listingId: 7,
    occurredAt: "2026-07-26T12:00:00.000Z",
    spec: {
      code: "price_changed",
      detail: "The price changed",
      reason: "the listing price changed while they were paying",
    },
  },
  PAYMENT_PLACEHOLDER_RESULT,
);

export const PAYMENT_CHECKOUT_CREATE: PaymentCheckoutCreateSnapshot = {
  baseUrl: "https://tickets.example",
  bookingIntent: PAYMENT_INTENT,
  expected: { amount: 1_000, currency: "GBP" },
  localPaymentId: PAYMENT_ID,
  metadata: {
    items: JSON.stringify(PAYMENT_INTENT.items),
    name: PAYMENT_INTENT.name,
    payment_id: PAYMENT_ID,
  },
  order: {
    extras: [],
    lines: [{ amount: 1_000, name: "General", quantity: 1 }],
  },
};

export const SESSION_RESOURCE: ProviderSessionResource = {
  id: "cs_test_1",
  kind: "stripe_checkout_session",
  provider: "stripe",
};

export const CHARGE_RESOURCE: ProviderChargeResource = {
  id: "pi_test_1",
  kind: "stripe_payment_intent",
  parentId: SESSION_RESOURCE.id,
  provider: "stripe",
};

export const REFUND_RESOURCE: ProviderRefundResource = {
  id: "re_test_1",
  kind: "stripe_refund",
  parentId: CHARGE_RESOURCE.id,
  provider: "stripe",
};

export const reviewedPaymentSnapshot = (
  accountId = "acct_test_1",
): PaymentChargeDecisionSnapshot => ({
  accountId,
  charges: [
    {
      captured: { amount: 1_000, currency: "GBP" },
      chargeId: 1,
      providerReference: CHARGE_RESOURCE,
      refunded: { amount: 0, currency: "GBP" },
    },
  ],
  kind: "charges",
  mode: "test",
  paymentId: PAYMENT_ID,
  provider: "stripe",
});

export const WRONG_CHARGE_RESOURCES: ProviderChargeResource[] = [
  { ...CHARGE_RESOURCE, parentId: "other-session" },
  {
    id: "square-payment",
    kind: "square_payment",
    parentId: SESSION_RESOURCE.id,
    provider: "square",
  },
];

export const WRONG_REFUND_RESOURCES: ProviderRefundResource[] = [
  { ...REFUND_RESOURCE, parentId: "other-charge" },
  {
    id: "square-refund",
    kind: "square_refund",
    parentId: CHARGE_RESOURCE.id,
    provider: "square",
  },
];

export const paymentSessionInput = (
  id = PAYMENT_ID,
  session: ProviderSessionResource | null = SESSION_RESOURCE,
): PaymentSessionCreate => ({
  accountId: "acct_test_1",
  bookingIntent: PAYMENT_INTENT,
  checkoutCreate: null,
  expected: { amount: 1_000, currency: "GBP" },
  id,
  mode: "test",
  provider: "stripe",
  session:
    session === SESSION_RESOURCE && id !== PAYMENT_ID
      ? { ...SESSION_RESOURCE, id: `cs_${id}` }
      : session,
});

export const chargeLeg = (
  refundedAmount = 0,
  refunds: ChargeLeg["refunds"] = [],
): ChargeLeg => ({
  captured: { amount: 1_000, currency: "GBP" },
  confirmedRefunded: { amount: refundedAmount, currency: "GBP" },
  refunds,
  resource: CHARGE_RESOURCE,
});

export const READY_RESULT = {
  observation: {
    accountId: "acct_test_1",
    bookingIntent: PAYMENT_INTENT,
    charges: [chargeLeg()],
    createdAt: "2026-07-26T12:00:00.000Z",
    expected: { amount: 1_000, currency: "GBP" },
    mode: "test",
    ownership: {
      localPaymentId: PAYMENT_ID,
      method: "signed",
      signature: "signature-1",
    },
    providerTotal: { amount: 1_000, currency: "GBP" },
    session: SESSION_RESOURCE,
    status: "paid",
  },
  status: "ready",
} satisfies PaymentResolution;

export const sessionProgress = (
  changes: Partial<PaymentSessionProgress> = {},
): PaymentSessionProgress => ({
  attendeeId: null,
  completion: null,
  completionState: "none",
  nextReconcileAt: PAYMENT_TIME + 60_000,
  result: null,
  resultState: "none",
  session: SESSION_RESOURCE,
  state: "pending",
  ticketState: "none",
  ticketTokens: null,
  ...changes,
});
