import * as v from "valibot";
import { sumOf } from "#fp";
import { BookingIntentSchema } from "#shared/booking-intent.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import {
  MoneySchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { UrlSchema } from "#shared/validation/string.ts";

const DisplayLineSchema = v.strictObject({
  amount: integerAtLeast(0),
  name: v.string(),
  quantity: integerAtLeast(1),
});

const DisplayOrderSchema = v.strictObject({
  extras: v.array(DisplayLineSchema),
  lines: v.pipe(v.array(DisplayLineSchema), v.minLength(1)),
});
type DisplayOrder = v.InferOutput<typeof DisplayOrderSchema>;

const BaseUrlSchema = v.pipe(
  UrlSchema,
  v.check((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      value === url.origin
    );
  }, "Payment checkout base URL must be an HTTP origin"),
);

const MetadataSchema = v.record(ResourceIdSchema, v.string());

const displayTotal = (order: DisplayOrder): number =>
  sumOf((line: DisplayOrder["lines"][number]) => line.amount * line.quantity)([
    ...order.lines,
    ...order.extras,
  ]);

/** Exact encrypted input needed to repeat one provider checkout creation. */
export const PaymentCheckoutCreateSnapshotSchema = v.pipe(
  v.strictObject({
    baseUrl: BaseUrlSchema,
    bookingIntent: BookingIntentSchema,
    expected: MoneySchema,
    localPaymentId: ResourceIdSchema,
    metadata: MetadataSchema,
    order: DisplayOrderSchema,
  }),
  v.check(
    (value) => value.metadata.payment_id === value.localPaymentId,
    "Payment checkout metadata must contain its local payment id",
  ),
  v.check(
    (value) => displayTotal(value.order) === value.expected.amount,
    "Payment checkout display order must equal its expected amount",
  ),
);

export type PaymentCheckoutCreateSnapshot = v.InferOutput<
  typeof PaymentCheckoutCreateSnapshotSchema
>;

/** Keep only the fully-priced display facts providers put on checkout pages. */
export const checkoutDisplayOrder = (order: PricedOrder): DisplayOrder =>
  v.parse(DisplayOrderSchema, {
    extras: order.extras.map((extra) => ({
      amount: extra.amount,
      name: extra.name,
      quantity: extra.quantity,
    })),
    lines: order.lines.map((line) => ({
      amount: line.chargedUnitAmount,
      name: line.item.name,
      quantity: line.quantity,
    })),
  });
