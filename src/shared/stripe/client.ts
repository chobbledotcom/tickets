import type Stripe from "stripe";
import type * as v from "valibot";
import type { RecurringInterval } from "#shared/subscriptions/plan.ts";
import type { StripeFormValue } from "./form.ts";
import {
  createStripeRequest,
  type StripeClientConfig,
  type StripeRequestOptions,
} from "./request.ts";
import {
  type StripeBalance,
  StripeBalanceSchema,
  type StripeCheckoutSession,
  StripeCheckoutSessionSchema,
  type StripeCreatedWebhookEndpoint,
  StripeCreatedWebhookEndpointSchema,
  type StripeDeletedWebhookEndpoint,
  StripeDeletedWebhookEndpointSchema,
  type StripeExpandedPaymentIntent,
  StripeExpandedPaymentIntentSchema,
  type StripeInvoicePayments,
  StripeInvoicePaymentsSchema,
  type StripeRefund,
  StripeRefundSchema,
  type StripeSubscription,
  StripeSubscriptionSchema,
  type StripeWebhookEndpointList,
  StripeWebhookEndpointListSchema,
} from "./schemas.ts";

type OfficialCheckoutParams = NonNullable<
  Parameters<Stripe["checkout"]["sessions"]["create"]>[0]
>;
type StripeRetryOptions = Pick<StripeRequestOptions, "maxNetworkRetries">;
type OfficialLineItem = NonNullable<
  OfficialCheckoutParams["line_items"]
>[number];
type StripePriceData = NonNullable<OfficialLineItem["price_data"]>;
type StripeProductData = NonNullable<StripePriceData["product_data"]>;

interface StripeProductDataParams
  extends Readonly<Record<string, StripeFormValue>> {
  description?: StripeProductData["description"];
  name: StripeProductData["name"];
}

interface StripePriceDataParams
  extends Readonly<Record<string, StripeFormValue>> {
  currency: StripePriceData["currency"];
  product_data: StripeProductDataParams;
  recurring?: {
    interval: Extract<
      NonNullable<StripePriceData["recurring"]>["interval"],
      RecurringInterval
    >;
  };
  unit_amount: NonNullable<StripePriceData["unit_amount"]>;
}

export interface StripeCheckoutLineItemParams
  extends Readonly<Record<string, StripeFormValue>> {
  price_data: StripePriceDataParams;
  quantity: NonNullable<OfficialLineItem["quantity"]>;
}

export interface StripeCheckoutSessionCreateParams {
  cancel_url: NonNullable<OfficialCheckoutParams["cancel_url"]>;
  customer_email?: NonNullable<OfficialCheckoutParams["customer_email"]>;
  /** When the session stops taking payment, as unix seconds. Stripe accepts
   *  30 minutes to 24 hours from creation. */
  expires_at: NonNullable<OfficialCheckoutParams["expires_at"]>;
  line_items: readonly StripeCheckoutLineItemParams[];
  metadata: Readonly<Record<string, string>>;
  mode: Extract<OfficialCheckoutParams["mode"], "payment" | "subscription">;
  payment_method_types: readonly [
    "card" &
      NonNullable<OfficialCheckoutParams["payment_method_types"]>[number],
  ];
  /** Only in subscription mode. The trial holds the recurring price back
   *  for one period, while the one-time lines charge at once. */
  subscription_data?: {
    metadata: Readonly<Record<string, string>>;
    trial_end: number;
  };
  success_url: NonNullable<OfficialCheckoutParams["success_url"]>;
}

export interface StripeWebhookEndpointCreateParams {
  api_version: NonNullable<Stripe.WebhookEndpointCreateParams["api_version"]>;
  enabled_events: readonly [
    "checkout.session.completed" &
      Stripe.WebhookEndpointCreateParams.EnabledEvent,
  ];
  url: Stripe.WebhookEndpointCreateParams["url"];
}

interface StripeRefundCreateParams
  extends Readonly<Record<string, StripeFormValue>> {
  amount: NonNullable<Stripe.RefundCreateParams["amount"]>;
  payment_intent: NonNullable<Stripe.RefundCreateParams["payment_intent"]>;
}

export interface StripeClient {
  balance: { retrieve: () => Promise<StripeBalance> };
  checkout: {
    sessions: {
      create: (
        params: StripeCheckoutSessionCreateParams,
      ) => Promise<StripeCheckoutSession>;
      retrieve: (
        id: Stripe.Checkout.Session["id"],
      ) => Promise<StripeCheckoutSession>;
    };
  };
  invoices: {
    retrieveWithPayments: (
      id: Stripe.Invoice["id"],
    ) => Promise<StripeInvoicePayments>;
  };
  paymentIntents: {
    retrieveWithLatestCharge: (
      id: Stripe.PaymentIntent["id"],
      options?: StripeRetryOptions,
    ) => Promise<StripeExpandedPaymentIntent>;
  };
  refunds: {
    create: (
      params: StripeRefundCreateParams,
      idempotencyKey?: string,
      options?: StripeRetryOptions,
    ) => Promise<StripeRefund>;
  };
  subscriptions: {
    /** Cancel at once, with no refund and no final invoice. */
    cancel: (id: Stripe.Subscription["id"]) => Promise<StripeSubscription>;
    retrieve: (id: Stripe.Subscription["id"]) => Promise<StripeSubscription>;
  };
  webhookEndpoints: {
    create: (
      params: StripeWebhookEndpointCreateParams,
    ) => Promise<StripeCreatedWebhookEndpoint>;
    del: (
      id: Stripe.WebhookEndpoint["id"],
    ) => Promise<StripeDeletedWebhookEndpoint>;
    list: (startingAfter?: string) => Promise<StripeWebhookEndpointList>;
  };
}

/** The subscription reads ask once. Each caller asks again on its own: the
 * scheduled check on its next pass, and a checkout on the next delivery. A
 * retry inside the call also spends calls that the check does not declare. */
const ASK_ONCE: StripeRetryOptions = { maxNetworkRetries: 0 };

/** Build the small Stripe API surface used by ticket payments. */
export const createStripeClient = (
  secretKey: string,
  config: StripeClientConfig = {},
): StripeClient => {
  const call = createStripeRequest(secretKey, config);
  const idPath = (resource: string, id: string): string =>
    `/v1/${resource}/${encodeURIComponent(id)}`;
  /** One resource's read (or delete) by id: `GET` or `DELETE` on the
   * resource's id path, shaped by the schema. */
  const oneById =
    <Schema extends v.GenericSchema>(
      method: "GET" | "DELETE",
      resource: string,
      schema: Schema,
      params: Record<string, StripeFormValue> = {},
      options?: StripeRetryOptions,
    ) =>
    (id: string): Promise<v.InferOutput<Schema>> =>
      call(method, idPath(resource, id), params, schema, options);

  return {
    balance: {
      retrieve: () => call("GET", "/v1/balance", {}, StripeBalanceSchema),
    },
    checkout: {
      sessions: {
        create: (params) =>
          call(
            "POST",
            "/v1/checkout/sessions",
            { ...params },
            StripeCheckoutSessionSchema,
          ),
        retrieve: oneById(
          "GET",
          "checkout/sessions",
          StripeCheckoutSessionSchema,
        ),
      },
    },
    invoices: {
      retrieveWithPayments: oneById(
        "GET",
        "invoices",
        StripeInvoicePaymentsSchema,
        { expand: ["payments"] },
        ASK_ONCE,
      ),
    },
    paymentIntents: {
      retrieveWithLatestCharge: (id, options) =>
        call(
          "GET",
          idPath("payment_intents", id),
          { expand: ["latest_charge"] },
          StripeExpandedPaymentIntentSchema,
          options,
        ),
    },
    refunds: {
      create: (params, idempotencyKey, options) =>
        call("POST", "/v1/refunds", params, StripeRefundSchema, {
          ...options,
          idempotencyKey,
        }),
    },
    subscriptions: {
      cancel: oneById("DELETE", "subscriptions", StripeSubscriptionSchema),
      retrieve: oneById(
        "GET",
        "subscriptions",
        StripeSubscriptionSchema,
        {},
        ASK_ONCE,
      ),
    },
    webhookEndpoints: {
      create: (params) =>
        call(
          "POST",
          "/v1/webhook_endpoints",
          { ...params },
          StripeCreatedWebhookEndpointSchema,
        ),
      del: oneById(
        "DELETE",
        "webhook_endpoints",
        StripeDeletedWebhookEndpointSchema,
      ),
      list: (startingAfter) =>
        call(
          "GET",
          "/v1/webhook_endpoints",
          { limit: 100, starting_after: startingAfter },
          StripeWebhookEndpointListSchema,
        ),
    },
  };
};
