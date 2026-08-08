import type Stripe from "stripe";
import * as v from "valibot";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const NonEmptyNullableStringSchema = v.nullable(NonEmptyTextSchema);
const MetadataSchema = v.nullable(v.record(v.string(), v.string()));
const StripePaymentStatuses = [
  "no_payment_required",
  "paid",
  "unpaid",
] as const satisfies readonly Stripe.Checkout.Session["payment_status"][];
const StripePaymentStatusSchema = v.picklist(StripePaymentStatuses);

type StripeCheckoutSessionFields = {
  amount_total: number | null;
  created: number;
  /** Stripe always sends a currency on a real session; the schema leaves it
   *  optional so a test payload (or a future session shape) without one still
   *  parses here — `validatedPaymentSession` then refuses the session, because
   *  a missing currency is never defaulted to the site's. */
  currency?: string | null;
  id: string;
  metadata: Stripe.Checkout.Session["metadata"];
  payment_intent: string | null;
  payment_status: (typeof StripePaymentStatuses)[number];
  url: string | null;
};

export const StripeCheckoutSessionSchema = v.object({
  amount_total: v.nullable(v.number()),
  created: v.number(),
  currency: v.optional(v.nullable(v.string())),
  id: NonEmptyTextSchema,
  metadata: MetadataSchema,
  payment_intent: NonEmptyNullableStringSchema,
  payment_status: StripePaymentStatusSchema,
  url: NonEmptyNullableStringSchema,
}) as v.GenericSchema<unknown, StripeCheckoutSessionFields>;

export type StripeCheckoutSession = StripeCheckoutSessionFields;

type StripeExpandedPaymentIntentFields = Pick<Stripe.PaymentIntent, "id"> & {
  latest_charge: null | Pick<Stripe.Charge, "refunded">;
};

export const StripeExpandedPaymentIntentSchema: v.GenericSchema<
  unknown,
  StripeExpandedPaymentIntentFields
> = v.object({
  id: NonEmptyTextSchema,
  latest_charge: v.nullable(v.object({ refunded: v.boolean() })),
});

export type StripeExpandedPaymentIntent = StripeExpandedPaymentIntentFields;

const StripeRefundStatuses = [
  "canceled",
  "failed",
  "pending",
  "requires_action",
  "succeeded",
] as const satisfies readonly NonNullable<Stripe.Refund["status"]>[];

type StripeRefundFields = Pick<Stripe.Refund, "id"> & {
  status: (typeof StripeRefundStatuses)[number] | null;
};

export const StripeRefundSchema: v.GenericSchema<unknown, StripeRefundFields> =
  v.object({
    id: NonEmptyTextSchema,
    status: v.nullable(v.picklist(StripeRefundStatuses)),
  });

export type StripeRefund = StripeRefundFields;

type StripeBalanceFields = Pick<Stripe.Balance, "livemode">;

export const StripeBalanceSchema: v.GenericSchema<
  unknown,
  StripeBalanceFields
> = v.object({ livemode: v.boolean() });
export type StripeBalance = StripeBalanceFields;

const StripeWebhookEndpointStatuses = [
  "disabled",
  "enabled",
] as const satisfies readonly Stripe.WebhookEndpoint["status"][];

type StripeWebhookEndpointFields = Pick<
  Stripe.WebhookEndpoint,
  "enabled_events" | "id" | "url"
> & { status: (typeof StripeWebhookEndpointStatuses)[number] };

export const StripeWebhookEndpointSchema: v.GenericSchema<
  unknown,
  StripeWebhookEndpointFields
> = v.object({
  enabled_events: v.array(v.string()),
  id: NonEmptyTextSchema,
  status: v.picklist(StripeWebhookEndpointStatuses),
  url: NonEmptyTextSchema,
});

export type StripeWebhookEndpoint = StripeWebhookEndpointFields;

type StripeCreatedWebhookEndpointFields = Pick<Stripe.WebhookEndpoint, "id"> & {
  secret: string;
};

export const StripeCreatedWebhookEndpointSchema: v.GenericSchema<
  unknown,
  StripeCreatedWebhookEndpointFields
> = v.object({
  id: NonEmptyTextSchema,
  secret: NonEmptyTextSchema,
});

export type StripeCreatedWebhookEndpoint = StripeCreatedWebhookEndpointFields;

type StripeDeletedWebhookEndpointFields = Pick<
  Stripe.DeletedWebhookEndpoint,
  "deleted" | "id"
>;

export const StripeDeletedWebhookEndpointSchema: v.GenericSchema<
  unknown,
  StripeDeletedWebhookEndpointFields
> = v.object({
  deleted: v.literal(true),
  id: NonEmptyTextSchema,
});

export type StripeDeletedWebhookEndpoint = StripeDeletedWebhookEndpointFields;

export const StripeWebhookEndpointListSchema = v.object({
  data: v.array(StripeWebhookEndpointSchema),
  has_more: v.boolean(),
});

export type StripeWebhookEndpointList = v.InferOutput<
  typeof StripeWebhookEndpointListSchema
>;

type StripeErrorFields = {
  error: {
    code?: Stripe.StripeRawError["code"];
    message: NonNullable<Stripe.StripeRawError["message"]>;
    type?: Stripe.StripeRawError["type"];
  };
};

const StripeErrorBodySchema: v.GenericSchema<unknown, StripeErrorFields> =
  v.object({
    error: v.object({
      code: v.optional(
        v.custom<NonNullable<Stripe.StripeRawError["code"]>>(
          (value) => typeof value === "string",
        ),
      ),
      message: NonEmptyTextSchema,
      type: v.optional(
        v.custom<NonNullable<Stripe.StripeRawError["type"]>>(
          (value) => typeof value === "string",
        ),
      ),
    }),
  });

export const parseStripeErrorBody = (body: string): StripeErrorFields =>
  v.parse(StripeErrorBodySchema, JSON.parse(body));
