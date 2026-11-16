import type Stripe from "stripe";
import * as v from "valibot";
import { ResourceIdSchema } from "#payment/resource-id.ts";
import {
  RecurringIntervalSchema,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";
import {
  NonEmptyTextSchema,
  OptionalNullableStringSchema,
} from "#shared/validation/string.ts";

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
  /** When the session stops taking payment, on Stripe's own clock. */
  expires_at: number | null;
  id: string;
  metadata: Stripe.Checkout.Session["metadata"];
  mode: (typeof StripeSessionModes)[number];
  payment_intent: string | null;
  payment_status: (typeof StripePaymentStatuses)[number];
  /** `expired` names a session whose payment window closed; Stripe refuses
   *  payment on it, so it is a terminal non-payment. */
  status: (typeof StripeSessionStatuses)[number];
  /** The first invoice of a subscription-mode session. A later invoice of
   *  the same subscription is a renewal, never the checkout. */
  invoice: string | null;
  /** The subscription a completed subscription-mode session started. */
  subscription: string | null;
  url: string | null;
};

const StripeSessionModes = [
  "payment",
  "setup",
  "subscription",
] as const satisfies readonly Stripe.Checkout.Session["mode"][];

const StripeSessionStatuses = [
  "complete",
  "expired",
  "open",
] as const satisfies readonly Stripe.Checkout.Session["status"][];

export const StripeCheckoutSessionSchema = v.object({
  amount_total: v.nullable(v.number()),
  created: v.number(),
  currency: OptionalNullableStringSchema,
  expires_at: v.nullable(v.number()),
  id: NonEmptyTextSchema,
  invoice: NonEmptyNullableStringSchema,
  metadata: MetadataSchema,
  mode: v.picklist(StripeSessionModes),
  payment_intent: NonEmptyNullableStringSchema,
  payment_status: StripePaymentStatusSchema,
  status: v.picklist(StripeSessionStatuses),
  subscription: NonEmptyNullableStringSchema,
  url: NonEmptyNullableStringSchema,
}) as v.GenericSchema<unknown, StripeCheckoutSessionFields>;

export type StripeCheckoutSession = StripeCheckoutSessionFields;

/** A subscription. The site starts each subscription with one item, so the
 * item's price is the charge each period. */
export const StripeSubscriptionSchema = v.object({
  id: ResourceIdSchema,
  items: v.object({
    data: v.tuple([
      v.object({
        price: v.object({
          recurring: v.object({ interval: RecurringIntervalSchema }),
          unit_amount: v.number(),
        }),
        quantity: v.number(),
      }),
    ]),
  }),
  metadata: v.record(v.string(), v.string()),
  status: SubscriptionStatusSchema,
});

export type StripeSubscription = v.InferOutput<typeof StripeSubscriptionSchema>;

/** One invoice with its payments. A paid entry names the intent that paid it. */
export const StripeInvoicePaymentsSchema = v.object({
  id: ResourceIdSchema,
  payments: v.object({
    data: v.array(
      v.object({
        payment: v.object({
          payment_intent: v.optional(NonEmptyNullableStringSchema, null),
          type: v.string(),
        }),
        status: v.string(),
      }),
    ),
  }),
});

export type StripeInvoicePayments = v.InferOutput<
  typeof StripeInvoicePaymentsSchema
>;

/** The paid invoices of one subscription, newest first. */
export const StripePaidInvoiceListSchema = v.object({
  data: v.array(
    v.object({
      amount_paid: v.number(),
      billing_reason: v.nullable(v.string()),
      currency: v.string(),
      id: ResourceIdSchema,
      status_transitions: v.object({ paid_at: v.number() }),
    }),
  ),
});

export type StripePaidInvoice = v.InferOutput<
  typeof StripePaidInvoiceListSchema
>["data"][number];

type StripeExpandedPaymentIntentFields = Pick<Stripe.PaymentIntent, "id"> & {
  latest_charge: null | Pick<
    Stripe.Charge,
    | "amount_captured"
    | "amount_refunded"
    | "captured"
    | "currency"
    | "paid"
    | "status"
  >;
};

const StripeChargeStatusSchema = v.picklist([
  "failed",
  "pending",
  "succeeded",
] as const satisfies readonly Stripe.Charge.Status[]);

/** The latest charge is expanded with its captured money and settled state.
 * The intended amount may exceed a partial capture, so it is not evidence of
 * how much can safely go back. */
export const StripeExpandedPaymentIntentSchema: v.GenericSchema<
  unknown,
  StripeExpandedPaymentIntentFields
> = v.object({
  id: NonEmptyTextSchema,
  latest_charge: v.nullable(
    v.object({
      amount_captured: v.number(),
      amount_refunded: v.number(),
      captured: v.boolean(),
      currency: NonEmptyTextSchema,
      paid: v.boolean(),
      status: StripeChargeStatusSchema,
    }),
  ),
});

export type StripeExpandedPaymentIntent = StripeExpandedPaymentIntentFields;

const StripeRefundStatuses = [
  "canceled",
  "failed",
  "pending",
  "requires_action",
  "succeeded",
] as const satisfies readonly NonNullable<Stripe.Refund["status"]>[];

type StripeRefundFields = Pick<Stripe.Refund, "amount" | "currency" | "id"> & {
  payment_intent: string;
  status: (typeof StripeRefundStatuses)[number] | null;
};

export const StripeRefundSchema: v.GenericSchema<unknown, StripeRefundFields> =
  v.object({
    amount: v.number(),
    currency: NonEmptyTextSchema,
    id: ResourceIdSchema,
    payment_intent: ResourceIdSchema,
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

export type StripeErrorFields = {
  error: {
    code?: Stripe.StripeRawError["code"];
    message: NonNullable<Stripe.StripeRawError["message"]>;
    type?: Stripe.StripeRawError["type"];
  };
};

export const StripeErrorBodySchema: v.GenericSchema<
  unknown,
  StripeErrorFields
> = v.object({
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
