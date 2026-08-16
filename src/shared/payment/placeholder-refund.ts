/** Why a signed payment became a quantity-0 placeholder. */
export type PlaceholderRefund = {
  alert?: RefundAlert;
  code: RefundCode;
  reason: string;
  detail: string;
};

export type RefundAlert = "payment_session" | "webhook_price_signature";

/** The complete schema of placeholder-refund reasons and operator wording. */
const REFUND_REASONS = {
  capacity_full: { reason: "the event filled up while they were paying" },
  charge_mismatch: {
    alert: "webhook_price_signature",
    reason: "the amount charged did not match the agreed total",
  },
  listing_removed: {
    alert: "payment_session",
    reason: "the listing was removed while they were paying",
  },
  malformed_charge: {
    alert: "payment_session",
    reason:
      "the provider reported the payment in a form the site could not read",
  },
  price_changed: {
    reason: "the listing price changed while they were paying",
  },
  sold_out: {
    reason: "an add-on or extra they chose sold out while they were paying",
  },
  unexpected_error: {
    alert: "payment_session",
    reason: "an unexpected error stopped the booking being completed",
  },
} as const satisfies Record<string, { reason: string; alert?: RefundAlert }>;

export type RefundCode = keyof typeof REFUND_REASONS;

/** Add an internal detail to one reason from the shared schema. */
export const placeholderRefund =
  (code: RefundCode) =>
  (detail: string): PlaceholderRefund => ({
    code,
    detail,
    ...REFUND_REASONS[code],
  });

const placeholderRefundNoteText = (
  attendeeId: number,
  refund: PlaceholderRefund,
  refunded: boolean,
): string => {
  const ledger = `[ledger](/admin/ledger/attendee/${attendeeId})`;
  return refunded
    ? `This booking was kept at quantity 0 but its payment was refunded because ${refund.reason}. Refund code: ${refund.code}. Please check the ${ledger}.`
    : `This booking was kept at quantity 0 because ${refund.reason}. Its refund is tracked in Refund recovery. Refund code: ${refund.code}. Please check the ${ledger}.`;
};

/** The PII-free system note for a quantity-0 placeholder refund. */
export const placeholderRefundNote = (
  attendeeId: number,
  refund: PlaceholderRefund,
  refunded: boolean,
): string => placeholderRefundNoteText(attendeeId, refund, refunded);
