import type Stripe from "stripe";
import type { StripeFormValue } from "./form.ts";
import { createStripeRequest, type StripeClientConfig } from "./request.ts";
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
  type StripeRefund,
  StripeRefundSchema,
  type StripeWebhookEndpoint,
  StripeWebhookEndpointListSchema,
} from "./schemas.ts";

type OfficialCheckoutParams = NonNullable<
  Parameters<Stripe["checkout"]["sessions"]["create"]>[0]
>;
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
  expires_at: NonNullable<OfficialCheckoutParams["expires_at"]>;
  line_items: readonly StripeCheckoutLineItemParams[];
  metadata: Readonly<Record<string, string>>;
  mode: Extract<OfficialCheckoutParams["mode"], "payment">;
  payment_method_types: readonly [
    "card" &
      NonNullable<OfficialCheckoutParams["payment_method_types"]>[number],
  ];
  success_url: NonNullable<OfficialCheckoutParams["success_url"]>;
}

export interface StripeWebhookEndpointCreateParams {
  api_version: NonNullable<Stripe.WebhookEndpointCreateParams["api_version"]>;
  enabled_events: readonly [
    "checkout.session.completed" &
      Stripe.WebhookEndpointCreateParams.EnabledEvent,
    "checkout.session.expired" &
      Stripe.WebhookEndpointCreateParams.EnabledEvent,
  ];
  url: Stripe.WebhookEndpointCreateParams["url"];
}

type CheckoutSessionById = (
  id: Stripe.Checkout.Session["id"],
) => Promise<StripeCheckoutSession>;

export interface StripeClient {
  balance: { retrieve: () => Promise<StripeBalance> };
  checkout: {
    sessions: {
      create: (
        params: StripeCheckoutSessionCreateParams,
      ) => Promise<StripeCheckoutSession>;
      expire: CheckoutSessionById;
      retrieve: CheckoutSessionById;
    };
  };
  paymentIntents: {
    retrieveWithLatestCharge: (
      id: Stripe.PaymentIntent["id"],
    ) => Promise<StripeExpandedPaymentIntent>;
  };
  refunds: {
    create: (
      params: Pick<Stripe.RefundCreateParams, "payment_intent">,
      idempotencyKey?: string,
    ) => Promise<StripeRefund>;
  };
  webhookEndpoints: {
    create: (
      params: StripeWebhookEndpointCreateParams,
    ) => Promise<StripeCreatedWebhookEndpoint>;
    del: (
      id: Stripe.WebhookEndpoint["id"],
    ) => Promise<StripeDeletedWebhookEndpoint>;
    list: () => Promise<{ data: StripeWebhookEndpoint[] }>;
  };
}

/** Build the small Stripe API surface used by ticket payments. */
export const createStripeClient = (
  secretKey: string,
  config: StripeClientConfig = {},
): StripeClient => {
  const call = createStripeRequest(secretKey, config);
  const idPath = (resource: string, id: string): string =>
    `/v1/${resource}/${encodeURIComponent(id)}`;

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
        expire: (id) =>
          call(
            "POST",
            `${idPath("checkout/sessions", id)}/expire`,
            {},
            StripeCheckoutSessionSchema,
          ),
        retrieve: (id) =>
          call(
            "GET",
            idPath("checkout/sessions", id),
            {},
            StripeCheckoutSessionSchema,
          ),
      },
    },
    paymentIntents: {
      retrieveWithLatestCharge: (id) =>
        call(
          "GET",
          idPath("payment_intents", id),
          { expand: ["latest_charge"] },
          StripeExpandedPaymentIntentSchema,
        ),
    },
    refunds: {
      create: (params, idempotencyKey) =>
        call("POST", "/v1/refunds", params, StripeRefundSchema, {
          idempotencyKey,
        }),
    },
    webhookEndpoints: {
      create: (params) =>
        call(
          "POST",
          "/v1/webhook_endpoints",
          { ...params },
          StripeCreatedWebhookEndpointSchema,
        ),
      del: (id) =>
        call(
          "DELETE",
          idPath("webhook_endpoints", id),
          {},
          StripeDeletedWebhookEndpointSchema,
        ),
      list: () =>
        call(
          "GET",
          "/v1/webhook_endpoints",
          { limit: 100 },
          StripeWebhookEndpointListSchema,
        ),
    },
  };
};
