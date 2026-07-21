type BookingPaymentInput = {
  customUnitPrice: number | undefined;
  paymentsEnabled: boolean;
  quantity: number;
  unitPrice: number;
};

/** The payment work a booking needs after its effective unit price is known. */
export type BookingPaymentPlan =
  | { kind: "checkout"; unitPrice: number }
  | { kind: "direct"; remainingBalance: number };

/** Resolve pricing, checkout, and any provider-less balance in one pure step. */
export const planBookingPayment = (
  input: BookingPaymentInput,
): BookingPaymentPlan => {
  const unitPrice = input.customUnitPrice ?? input.unitPrice;
  if (input.paymentsEnabled && unitPrice > 0) {
    return { kind: "checkout", unitPrice };
  }
  return {
    kind: "direct",
    remainingBalance: input.paymentsEnabled
      ? 0
      : Math.max(0, unitPrice * input.quantity),
  };
};
