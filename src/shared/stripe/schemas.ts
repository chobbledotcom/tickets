import * as v from "valibot";

const NullableStringSchema = v.nullable(v.string());
const MetadataSchema = v.nullable(v.record(v.string(), v.string()));

export const StripeCheckoutSessionSchema = v.object({
  amount_total: v.nullable(v.number()),
  created: v.number(),
  id: v.string(),
  metadata: MetadataSchema,
  payment_intent: NullableStringSchema,
  payment_status: v.string(),
  url: NullableStringSchema,
});

export type StripeCheckoutSession = v.InferOutput<
  typeof StripeCheckoutSessionSchema
>;

export const StripePaymentIntentSchema = v.object({
  id: v.string(),
  latest_charge: v.union([
    v.null(),
    v.string(),
    v.object({ refunded: v.boolean() }),
  ]),
});

export type StripePaymentIntent = v.InferOutput<
  typeof StripePaymentIntentSchema
>;

export const StripeRefundSchema = v.object({
  id: v.string(),
  status: v.nullable(v.string()),
});

export type StripeRefund = v.InferOutput<typeof StripeRefundSchema>;

export const StripeBalanceSchema = v.object({ livemode: v.boolean() });
export type StripeBalance = v.InferOutput<typeof StripeBalanceSchema>;

export const StripeWebhookEndpointSchema = v.object({
  enabled_events: v.array(v.string()),
  id: v.string(),
  secret: v.optional(v.string()),
  status: v.string(),
  url: v.string(),
});

export type StripeWebhookEndpoint = v.InferOutput<
  typeof StripeWebhookEndpointSchema
>;

export const StripeWebhookEndpointWriteSchema = v.pick(
  StripeWebhookEndpointSchema,
  ["id", "secret"],
);

export type StripeWebhookEndpointWrite = v.InferOutput<
  typeof StripeWebhookEndpointWriteSchema
>;

export const StripeWebhookEndpointListSchema = v.object({
  data: v.array(StripeWebhookEndpointSchema),
});

export type StripeWebhookEndpointList = v.InferOutput<
  typeof StripeWebhookEndpointListSchema
>;

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
