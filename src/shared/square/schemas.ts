import * as v from "valibot";
import { MoneySchema } from "#shared/payment/money.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const SquareTenderSchema = v.object({
  id: v.optional(NonEmptyTextSchema),
  payment_id: v.optional(NonEmptyTextSchema),
});

const ReturnedRecordEntries = {
  id: v.optional(NonEmptyTextSchema),
  location_id: v.optional(NonEmptyTextSchema),
};

const SquareOrderSchema = v.object({
  created_at: v.optional(NonEmptyTextSchema),
  ...ReturnedRecordEntries,
  metadata: v.optional(v.record(v.string(), v.nullable(v.string()))),
  state: v.optional(NonEmptyTextSchema),
  tenders: v.optional(v.array(SquareTenderSchema)),
  total_money: v.optional(MoneySchema),
});

const SquarePaymentSchema = v.object({
  amount_money: v.optional(MoneySchema),
  ...ReturnedRecordEntries,
  order_id: v.optional(NonEmptyTextSchema),
  refunded_money: v.optional(MoneySchema),
  status: v.optional(NonEmptyTextSchema),
});

export const SquareOrderResponseSchema = v.object({
  order: v.optional(v.nullable(SquareOrderSchema)),
});

export const SquarePaymentResponseSchema = v.object({
  payment: v.optional(v.nullable(SquarePaymentSchema)),
});
