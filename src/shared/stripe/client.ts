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

interface StripeProductDataParams
  extends Readonly<Record<string, StripeFormValue>> {
  description?: string;
  name: string;
}

interface StripePriceDataParams
  extends Readonly<Record<string, StripeFormValue>> {
  currency: string;
  product_data: StripeProductDataParams;
  unit_amount: number;
}

export interface StripeCheckoutLineItemParams
  extends Readonly<Record<string, StripeFormValue>> {
  price_data: StripePriceDataParams;
  quantity: number;
}

export interface StripeCheckoutSessionCreateParams {
  cancel_url: string;
  customer_email?: string;
  line_items: readonly StripeCheckoutLineItemParams[];
  metadata: Readonly<Record<string, string>>;
  mode: "payment";
  payment_method_types: readonly ["card"];
  success_url: string;
}

export interface StripeWebhookEndpointCreateParams {
  api_version: string;
  enabled_events: readonly ["checkout.session.completed"];
  url: string;
}

export interface StripeClient {
  balance: { retrieve: () => Promise<StripeBalance> };
  checkout: {
    sessions: {
      create: (
        params: StripeCheckoutSessionCreateParams,
      ) => Promise<StripeCheckoutSession>;
      retrieve: (id: string) => Promise<StripeCheckoutSession>;
    };
  };
  paymentIntents: {
    retrieveWithLatestCharge: (
      id: string,
    ) => Promise<StripeExpandedPaymentIntent>;
  };
  refunds: {
    create: (params: { payment_intent: string }) => Promise<StripeRefund>;
  };
  webhookEndpoints: {
    create: (
      params: StripeWebhookEndpointCreateParams,
    ) => Promise<StripeCreatedWebhookEndpoint>;
    del: (id: string) => Promise<StripeDeletedWebhookEndpoint>;
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
      create: (params) =>
        call("POST", "/v1/refunds", params, StripeRefundSchema),
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
