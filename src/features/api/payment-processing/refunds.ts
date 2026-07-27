import type {
  BookingPayment,
  PaymentFailureResult,
} from "#routes/api/webhook-types.ts";
import { ErrorCode, type ErrorCodeType } from "#shared/logger.ts";
import type { RefundCode } from "#shared/payment-completion.ts";

export const validationFailure = (
  session: BookingPayment,
  validation: { error: string; status?: number },
  _listingId: number,
): PaymentFailureResult => ({
  detail: `Post-payment listing validation failed (session=${session.id})`,
  error: validation.error,
  status: validation.status,
  success: false,
});

export type RefundSpec = {
  code: RefundCode;
  detail: string;
  notify?: ErrorCodeType;
  reason: string;
};

const REFUND_REASONS = {
  capacity_full: { reason: "the event filled up while they were paying" },
  charge_mismatch: {
    notify: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
    reason: "the amount charged did not match the agreed total",
  },
  listing_removed: {
    notify: ErrorCode.PAYMENT_SESSION,
    reason: "the listing was removed while they were paying",
  },
  price_changed: {
    reason: "the listing price changed while they were paying",
  },
  sold_out: {
    reason: "an add-on or extra they chose sold out while they were paying",
  },
  unexpected_error: {
    notify: ErrorCode.PAYMENT_SESSION,
    reason: "an unexpected error stopped the booking being completed",
  },
} as const satisfies Record<
  RefundCode,
  { reason: string; notify?: ErrorCodeType }
>;

export type { RefundCode };

export const refundNotificationForCode = (
  code: RefundCode,
): ErrorCodeType | undefined => {
  const reason = REFUND_REASONS[code];
  return "notify" in reason ? reason.notify : undefined;
};

export const refundSpec =
  (code: RefundCode) =>
  (detail: string): RefundSpec => ({
    code,
    detail,
    ...REFUND_REASONS[code],
  });

export const deletedListingSpec = (session: BookingPayment): RefundSpec =>
  refundSpec("listing_removed")(
    `Listing not found for a signed session (session=${session.id})`,
  );

export const refundedNoteText = (
  attendeeId: number,
  spec: Pick<RefundSpec, "code" | "reason">,
  status: "pending" | "completed",
  paymentReference: string,
): string => {
  const ledger = `[ledger](/admin/ledger/attendee/${attendeeId})`;
  const ref = ` Payment reference: ${paymentReference} (code: ${spec.code}).`;
  return status === "completed"
    ? `This booking was kept at quantity 0 but its payment was refunded because ${spec.reason}.${ref} Please check the ${ledger}.`
    : `This booking was kept at quantity 0 but its refund is not complete because ${spec.reason}.${ref} Please check the ${ledger}.`;
};
