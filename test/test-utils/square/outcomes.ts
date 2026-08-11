import { assertThrows } from "@std/assert";
import * as v from "valibot";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";

/** Wrap an optional Square payment in the provider read it represents. */
export const squarePaymentRead = (
  payment: SquarePayment | null,
): ProviderRead<SquarePayment> =>
  payment ? { resource: payment, status: "found" } : { status: "missing" };

/** Produce the boundary error Square adapters receive from malformed data. */
export const squareBoundaryValidationError = (): unknown =>
  assertThrows(() => v.parse(v.string(), 1), v.ValiError);
