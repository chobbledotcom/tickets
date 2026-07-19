import * as v from "valibot";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const NullableStringSchema = v.nullable(v.string());
const MetadataSchema = v.nullable(v.record(v.string(), v.string()));
const StripePaymentStatusSchema = v.picklist([
  "no_payment_required",
  "paid",
  "unpaid",
]);

export const StripeCheckoutSessionSchema = v.object({
  amount_total: v.nullable(v.number()),
  created: v.number(),
  id: v.string(),
  metadata: MetadataSchema,
  payment_intent: NullableStringSchema,
  payment_status: StripePaymentStatusSchema,
  url: NullableStringSchema,
});

export type StripeCheckoutSession = v.InferOutput<
  typeof StripeCheckoutSessionSchema
>;

export const StripeExpandedPaymentIntentSchema = v.object({
  id: v.string(),
  latest_charge: v.nullable(v.object({ refunded: v.boolean() })),
});

export type StripeExpandedPaymentIntent = v.InferOutput<
  typeof StripeExpandedPaymentIntentSchema
>;

export const StripeRefundSchema = v.object({
  id: v.string(),
  status: v.nullable(
    v.picklist([
      "canceled",
      "failed",
      "pending",
      "requires_action",
      "succeeded",
    ]),
  ),
});

export type StripeRefund = v.InferOutput<typeof StripeRefundSchema>;

export const StripeBalanceSchema = v.object({ livemode: v.boolean() });
export type StripeBalance = v.InferOutput<typeof StripeBalanceSchema>;

export const StripeWebhookEndpointSchema = v.object({
  enabled_events: v.array(v.string()),
  id: v.string(),
  status: v.picklist(["disabled", "enabled"]),
  url: v.string(),
});

export type StripeWebhookEndpoint = v.InferOutput<
  typeof StripeWebhookEndpointSchema
>;

export const StripeCreatedWebhookEndpointSchema = v.object({
  id: v.string(),
  secret: NonEmptyTextSchema,
});

export type StripeCreatedWebhookEndpoint = v.InferOutput<
  typeof StripeCreatedWebhookEndpointSchema
>;

export const StripeDeletedWebhookEndpointSchema = v.object({
  deleted: v.literal(true),
  id: v.string(),
});

export type StripeDeletedWebhookEndpoint = v.InferOutput<
  typeof StripeDeletedWebhookEndpointSchema
>;

export const StripeWebhookEndpointListSchema = v.object({
  data: v.array(StripeWebhookEndpointSchema),
});

const StripeErrorBodySchema = v.object({
  error: v.object({
    code: v.optional(v.string()),
    message: v.string(),
    type: v.optional(v.string()),
  }),
});

export const parseStripeErrorBody = (
  body: string,
): v.InferOutput<typeof StripeErrorBodySchema> =>
  v.parse(StripeErrorBodySchema, JSON.parse(body));
