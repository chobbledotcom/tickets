/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { BookingIntentSchema } from "#shared/booking-intent.ts";
import {
  RefundResolutionSchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { isInstant } from "#shared/validation/timestamp.ts";

/* jscpd:ignore-end */

const PaymentSuccessSchema = v.strictObject({
  attendee: v.strictObject({ id: integerAtLeast(1) }),
  listingId: integerAtLeast(1),
  success: v.literal(true),
  ticketTokens: v.array(ResourceIdSchema),
});

const PaymentFailureSchema = v.strictObject({
  detail: v.optional(v.string()),
  error: v.string(),
  moneyStatus: v.optional(v.literal("not_taken")),
  refund: v.optional(RefundResolutionSchema),
  status: v.optional(integerAtLeast(100)),
  success: v.literal(false),
});

export const PaymentClientResultSchema = v.variant("success", [
  PaymentSuccessSchema,
  PaymentFailureSchema,
]);
export type PaymentClientResult = v.InferOutput<
  typeof PaymentClientResultSchema
>;

export const PaymentEffectStateSchema = v.picklist(["pending", "completed"]);
export type PaymentEffectState = v.InferOutput<typeof PaymentEffectStateSchema>;

export const BookingCompletionEffectSchema = v.picklist([
  "answers",
  "promo_activity",
  "registration_activity",
  "balance_activity",
  "external_delivery_setup",
  "external_deliveries",
]);
export type BookingCompletionEffect = v.InferOutput<
  typeof BookingCompletionEffectSchema
>;

const bookingEffectFields = {
  answers: PaymentEffectStateSchema,
  balance_activity: PaymentEffectStateSchema,
  external_deliveries: PaymentEffectStateSchema,
  external_delivery_setup: PaymentEffectStateSchema,
  promo_activity: PaymentEffectStateSchema,
  registration_activity: PaymentEffectStateSchema,
} satisfies Record<BookingCompletionEffect, typeof PaymentEffectStateSchema>;

const BookingEffectStatesSchema = v.strictObject(bookingEffectFields);

export const PlaceholderRefundEffectSchema = v.picklist([
  "provider_refund",
  "payment_ledger",
  "pending_note",
  "operator_alert",
  "refund_ledger",
  "completed_note",
  "refund_activity",
]);
export type PlaceholderRefundEffect = v.InferOutput<
  typeof PlaceholderRefundEffectSchema
>;

const placeholderRefundEffectFields = {
  completed_note: PaymentEffectStateSchema,
  operator_alert: PaymentEffectStateSchema,
  payment_ledger: PaymentEffectStateSchema,
  pending_note: PaymentEffectStateSchema,
  provider_refund: PaymentEffectStateSchema,
  refund_activity: PaymentEffectStateSchema,
  refund_ledger: PaymentEffectStateSchema,
} satisfies Record<PlaceholderRefundEffect, typeof PaymentEffectStateSchema>;

const PlaceholderRefundEffectStatesSchema = v.strictObject(
  placeholderRefundEffectFields,
);

export type PaymentCompletionEffect =
  | BookingCompletionEffect
  | PlaceholderRefundEffect;

export const RefundCodeSchema = v.picklist([
  "capacity_full",
  "charge_mismatch",
  "listing_removed",
  "price_changed",
  "registration_closed",
  "sold_out",
  "unexpected_error",
]);
export type RefundCode = v.InferOutput<typeof RefundCodeSchema>;

const PromoActivitySchema = v.strictObject({
  delta: v.pipe(v.number(), v.safeInteger()),
  modifierId: integerAtLeast(1),
  name: v.string(),
});
export type PromoActivity = v.InferOutput<typeof PromoActivitySchema>;

const OccurredAtSchema = v.pipe(v.string(), v.check(isInstant));

const BookingCompletionSchema = v.pipe(
  v.strictObject({
    effects: BookingEffectStatesSchema,
    facts: v.strictObject({
      flow: v.picklist(["registration", "balance"]),
      listingId: integerAtLeast(1),
      occurredAt: OccurredAtSchema,
      promos: v.array(PromoActivitySchema),
    }),
    input: BookingIntentSchema,
    kind: v.literal("booking"),
    result: v.strictObject({
      listingId: integerAtLeast(1),
      ticketTokens: v.array(ResourceIdSchema),
    }),
  }),
  v.check(
    (plan) =>
      (plan.facts.flow === "balance") ===
      (plan.input.balanceAttendeeId !== undefined),
    "Booking completion flow must match its canonical input",
  ),
  v.check(
    (plan) => plan.result.listingId === plan.facts.listingId,
    "Booking completion result must match its listing",
  ),
);
export type BookingCompletion = v.InferOutput<typeof BookingCompletionSchema>;

const PlaceholderRefundCompletionSchema = v.strictObject({
  effects: PlaceholderRefundEffectStatesSchema,
  facts: v.strictObject({
    amount: integerAtLeast(0),
    listingId: integerAtLeast(1),
    occurredAt: OccurredAtSchema,
    spec: v.strictObject({
      code: RefundCodeSchema,
      detail: v.string(),
      reason: v.string(),
    }),
  }),
  input: BookingIntentSchema,
  kind: v.literal("placeholder_refund"),
  result: PaymentFailureSchema,
});
export type PlaceholderRefundCompletion = v.InferOutput<
  typeof PlaceholderRefundCompletionSchema
>;

export const PaymentCompletionSchema = v.variant("kind", [
  BookingCompletionSchema,
  PlaceholderRefundCompletionSchema,
]);
export type PaymentCompletion = v.InferOutput<typeof PaymentCompletionSchema>;

const pendingBookingEffects = (): BookingCompletion["effects"] => ({
  answers: "pending",
  balance_activity: "pending",
  external_deliveries: "pending",
  external_delivery_setup: "pending",
  promo_activity: "pending",
  registration_activity: "pending",
});

const pendingPlaceholderRefundEffects =
  (): PlaceholderRefundCompletion["effects"] => ({
    completed_note: "pending",
    operator_alert: "pending",
    payment_ledger: "pending",
    pending_note: "pending",
    provider_refund: "pending",
    refund_activity: "pending",
    refund_ledger: "pending",
  });

export const bookingCompletion = (
  input: BookingCompletion["input"],
  facts: BookingCompletion["facts"],
  ticketTokens: string[],
): BookingCompletion =>
  v.parse(BookingCompletionSchema, {
    effects: pendingBookingEffects(),
    facts,
    input,
    kind: "booking",
    result: { listingId: facts.listingId, ticketTokens },
  });

export const placeholderRefundCompletion = (
  input: PlaceholderRefundCompletion["input"],
  facts: PlaceholderRefundCompletion["facts"],
  result: PlaceholderRefundCompletion["result"],
): PlaceholderRefundCompletion =>
  v.parse(PlaceholderRefundCompletionSchema, {
    effects: pendingPlaceholderRefundEffects(),
    facts,
    input,
    kind: "placeholder_refund",
    result,
  });

type PaymentWithCompletionResult = {
  attendeeId: number | null;
  completion: PaymentCompletion | null;
  id: string;
  ticketTokens: string[] | null;
};

/** Rebuild the exact callback result from the encrypted completion and aggregate. */
export const paymentCompletionResult = (
  payment: PaymentWithCompletionResult,
): PaymentClientResult => {
  const completion = payment.completion;
  if (completion === null) {
    throw new Error(`Payment ${payment.id} has no completion plan`);
  }
  if (completion.kind === "placeholder_refund") return completion.result;
  const attendeeId = payment.attendeeId;
  if (attendeeId === null) {
    throw new Error(`Payment ${payment.id} has no completion attendee`);
  }
  return {
    attendee: { id: attendeeId },
    listingId: completion.result.listingId,
    success: true,
    ticketTokens: completion.result.ticketTokens,
  };
};
