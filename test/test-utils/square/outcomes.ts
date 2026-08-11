import * as v from "valibot";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";

/** Wrap an optional Square payment in the provider read it represents. */
export const squarePaymentRead = (
  payment: SquarePayment | null,
): ProviderRead<SquarePayment> =>
  payment ? { resource: payment, status: "found" } : { status: "missing" };

/** Produce the boundary error Square adapters receive from malformed data. */
export const squareBoundaryValidationError = (): unknown => {
  try {
    v.parse(v.string(), 1);
  } catch (error) {
    return error;
  }
  throw new Error("The invalid value unexpectedly passed validation");
};
