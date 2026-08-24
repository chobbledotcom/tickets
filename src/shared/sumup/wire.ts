import * as v from "valibot";
import { providerDetail, transportError } from "#payment/transport-error.ts";

/** A wire string SumUp can leave out. Absence stays visible for each boundary
 * to judge, so no field here defaults itself away. */
const optionalText = v.optional(v.string());

/** Identity, money, account, and lifecycle fields shared by SumUp checkouts
 * and transactions. */
export const sumupPaymentFields = {
  amount: v.optional(v.number()),
  currency: optionalText,
  id: optionalText,
  merchant_code: optionalText,
  status: optionalText,
};

export const SumupWireTransactionSchema = v.object(sumupPaymentFields);

/** SumUp's documented transaction-event statuses. A status outside this list
 * is one we cannot read, so the money boundary refuses it rather than guess. */
export const SumupEventStatusSchema = v.picklist([
  "FAILED",
  "PAID_OUT",
  "PENDING",
  "RECONCILED",
  "REFUNDED",
  "SCHEDULED",
  "SUCCESSFUL",
]);
export type SumupEventStatus = v.InferOutput<typeof SumupEventStatusSchema>;

const CreatedSumupCheckoutSchema = v.object({
  hosted_checkout_url: optionalText,
  id: optionalText,
});

/** Read what SumUp answered a checkout creation with. Which of the two fields
 * a checkout cannot open without is decided by the caller, not by this parse. */
export const readCreatedSumupCheckout = (
  body: unknown,
): v.InferOutput<typeof CreatedSumupCheckoutSchema> => {
  const parsed = v.safeParse(CreatedSumupCheckoutSchema, body);
  if (!parsed.success) throw transportError.unusable(providerDetail.sumup());
  return parsed.output;
};
