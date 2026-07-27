import type Stripe from "stripe";
import * as v from "valibot";
import { StringMapSchema } from "#shared/provider-boundary.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const NonEmptyNullableStringSchema = v.nullable(NonEmptyTextSchema);
const stripeId = (prefix: string) =>
  v.pipe(NonEmptyTextSchema, v.startsWith(`${prefix}_`));
const CheckoutSessionIdSchema = stripeId("cs");
const PaymentIntentIdSchema = stripeId("pi");
const ChargeIdSchema = stripeId("ch");
const RefundIdSchema = stripeId("re");
const StripeAmountSchema = integerAtLeast(0);
const StripePositiveAmountSchema = v.pipe(StripeAmountSchema, v.minValue(1));
const StripeTimestampSchema = v.pipe(
  integerAtLeast(0),
  v.maxValue(8_640_000_000_000),
);
const StripeCurrencySchema = v.pipe(
  v.string(),
  v.regex(/^[a-z]{3}$/u, "Stripe currency must be three lowercase letters"),
);
const StripePaymentStatuses = [
  "no_payment_required",
  "paid",
  "unpaid",
] as const satisfies readonly Stripe.Checkout.Session["payment_status"][];
const StripePaymentStatusSchema = v.picklist(StripePaymentStatuses);

type StripeAccountFields = Pick<Stripe.Account, "id">;

export const StripeAccountSchema: v.GenericSchema<
  unknown,
  StripeAccountFields
> = v.object({ id: NonEmptyTextSchema });
export type StripeAccount = StripeAccountFields;
const StripeCheckoutStatuses = [
  "complete",
  "expired",
  "open",
] as const satisfies readonly NonNullable<Stripe.Checkout.Session["status"]>[];
const StripeCheckoutStatusSchema = v.picklist(StripeCheckoutStatuses);

type StripeCheckoutSessionFields = Pick<
  Stripe.Checkout.Session,
  "created" | "id" | "livemode" | "metadata" | "payment_status" | "url"
> & {
  amount_total: number;
  currency: string;
  payment_intent: Extract<
    Stripe.Checkout.Session["payment_intent"],
    string | null
  >;
  status: NonNullable<Stripe.Checkout.Session["status"]>;
};

export const StripeCheckoutSessionSchema: v.GenericSchema<
  unknown,
  StripeCheckoutSessionFields
> = v.object({
  amount_total: StripeAmountSchema,
  created: StripeTimestampSchema,
  currency: StripeCurrencySchema,
  id: CheckoutSessionIdSchema,
  livemode: v.boolean(),
  metadata: StringMapSchema,
  payment_intent: v.nullable(PaymentIntentIdSchema),
  payment_status: StripePaymentStatusSchema,
  status: StripeCheckoutStatusSchema,
  url: NonEmptyNullableStringSchema,
});

export type StripeCheckoutSession = StripeCheckoutSessionFields;

/** A checkout session as it comes back from creating one. Only the id and the
 *  link to send the buyer to are settled at this point — the money fields fill
 *  in once the buyer pays — so creation checks just those. */
export const StripeCreatedCheckoutSessionSchema = v.object({
  id: CheckoutSessionIdSchema,
  url: NonEmptyNullableStringSchema,
});
export type StripeCreatedCheckoutSession = v.InferOutput<
  typeof StripeCreatedCheckoutSessionSchema
>;

export type StripeCharge = Pick<
  Stripe.Charge,
  | "amount"
  | "amount_captured"
  | "amount_refunded"
  | "captured"
  | "created"
  | "currency"
  | "id"
  | "livemode"
  | "paid"
  | "refunded"
> & { payment_intent: string };

export const StripeChargeSchema: v.GenericSchema<unknown, StripeCharge> =
  v.pipe(
    v.object({
      amount: StripePositiveAmountSchema,
      amount_captured: StripeAmountSchema,
      amount_refunded: StripeAmountSchema,
      captured: v.boolean(),
      created: StripeTimestampSchema,
      currency: StripeCurrencySchema,
      id: ChargeIdSchema,
      livemode: v.boolean(),
      paid: v.boolean(),
      payment_intent: PaymentIntentIdSchema,
      refunded: v.boolean(),
    }),
    v.check(
      (charge) => charge.amount_captured <= charge.amount,
      "Stripe charge capture exceeds its amount",
    ),
    v.check(
      (charge) => charge.amount_refunded <= charge.amount_captured,
      "Stripe charge refund exceeds its capture",
    ),
    v.check(
      (charge) =>
        charge.refunded ===
        (charge.amount_captured > 0 &&
          charge.amount_refunded === charge.amount_captured),
      "Stripe charge refund status does not match its refunded amount",
    ),
  );

const StripePaymentIntentStatuses = [
  "canceled",
  "processing",
  "requires_action",
  "requires_capture",
  "requires_confirmation",
  "requires_payment_method",
  "succeeded",
] as const satisfies readonly Stripe.PaymentIntent["status"][];

type StripeExpandedPaymentIntentFields = Pick<
  Stripe.PaymentIntent,
  | "amount"
  | "amount_received"
  | "created"
  | "currency"
  | "id"
  | "livemode"
  | "status"
> & { latest_charge: StripeCharge | null };

export const StripeExpandedPaymentIntentSchema: v.GenericSchema<
  unknown,
  StripeExpandedPaymentIntentFields
> = v.object({
  amount: StripePositiveAmountSchema,
  amount_received: StripeAmountSchema,
  created: StripeTimestampSchema,
  currency: StripeCurrencySchema,
  id: PaymentIntentIdSchema,
  latest_charge: v.nullable(StripeChargeSchema),
  livemode: v.boolean(),
  status: v.picklist(StripePaymentIntentStatuses),
});

export type StripeExpandedPaymentIntent = StripeExpandedPaymentIntentFields;

const StripeRefundStatuses = [
  "canceled",
  "failed",
  "pending",
  "requires_action",
  "succeeded",
] as const satisfies readonly NonNullable<Stripe.Refund["status"]>[];

type StripeRefundFields = Pick<
  Stripe.Refund,
  "amount" | "created" | "currency" | "id"
> & {
  charge: string;
  payment_intent: string;
  status: (typeof StripeRefundStatuses)[number];
};

export const StripeRefundSchema: v.GenericSchema<unknown, StripeRefundFields> =
  v.object({
    amount: StripePositiveAmountSchema,
    charge: ChargeIdSchema,
    created: StripeTimestampSchema,
    currency: StripeCurrencySchema,
    id: RefundIdSchema,
    payment_intent: PaymentIntentIdSchema,
    status: v.picklist(StripeRefundStatuses),
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
});

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
