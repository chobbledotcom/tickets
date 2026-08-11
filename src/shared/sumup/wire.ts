import * as v from "valibot";

/** Identity, money, account, and lifecycle fields shared by SumUp checkouts
 * and transactions. Absence stays visible for each boundary to judge. */
export const sumupPaymentFields = {
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  id: v.optional(v.string()),
  merchant_code: v.optional(v.string()),
  status: v.optional(v.string()),
};

export const SumupWireTransactionSchema = v.object(sumupPaymentFields);
