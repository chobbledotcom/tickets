/* jscpd:ignore-start -- imports */
import {
  type ProviderRequest,
  providerCaller,
  readProviderJson,
} from "#payment/provider-fetch.ts";
import { providerDetail } from "#payment/transport-error.ts";

/* jscpd:ignore-end */

/** SumUp names no rejected field in its answers, so its detail never reads a
 * body. */
const sumupCaller = providerCaller(() => providerDetail.sumup());

const SUMUP_API_BASE = "https://api.sumup.com";

/** SumUp transport currently makes one physical fetch per logical call. */
export const SUMUP_MAX_NETWORK_RETRIES = 0;

/** The body SumUp needs to open one hosted checkout. */
export type SumupCheckoutRequest = {
  amount: number;
  checkout_reference: string;
  currency: string;
  description: string;
  hosted_checkout: { enabled: boolean };
  merchant_code: string;
  redirect_url: string;
  return_url: string;
};

export type SumupTransport = {
  createCheckout(body: SumupCheckoutRequest): Promise<unknown>;
  readCheckout(checkoutId: string): Promise<unknown>;
  readMerchant(merchantCode: string): Promise<unknown>;
  readTransaction(
    merchantCode: string,
    query: { id: string },
  ): Promise<unknown>;
  refundTransaction(merchantCode: string, transactionId: string): Promise<void>;
};

const sumupInit = (
  apiKey: string,
  method: "GET" | "POST",
  body?: SumupCheckoutRequest,
): ProviderRequest => ({
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: {
    Accept: "application/problem+json, application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  method,
});

const merchantPath = (merchantCode: string): string =>
  `/merchants/${encodeURIComponent(merchantCode)}`;

/** Every SumUp call the app makes, over the shared provider boundary so each
 * one carries the timeout and the subrequest count the edge budget needs. */
export const createSumupTransport = (apiKey: string): SumupTransport => {
  const readAt = (
    path: string,
    method: "GET" | "POST" = "GET",
    body?: SumupCheckoutRequest,
  ): Promise<unknown> =>
    sumupCaller.json(
      `${SUMUP_API_BASE}${path}`,
      sumupInit(apiKey, method, body),
    );
  return {
    createCheckout: (body) => readAt("/v0.1/checkouts", "POST", body),
    readCheckout: (checkoutId) =>
      readAt(`/v0.1/checkouts/${encodeURIComponent(checkoutId)}`),
    readMerchant: (merchantCode) => readAt(`/v1${merchantPath(merchantCode)}`),
    readTransaction: (merchantCode, { id }) =>
      readAt(
        `/v2.1${merchantPath(merchantCode)}/transactions?id=${encodeURIComponent(id)}`,
      ),
    refundTransaction: async (merchantCode, transactionId) => {
      const body = await sumupCaller.text(
        `${SUMUP_API_BASE}/v1.0${merchantPath(merchantCode)}/payments/${encodeURIComponent(transactionId)}/refunds`,
        sumupInit(apiKey, "POST"),
      );
      // The documented answer is empty. If SumUp adds a JSON envelope, it still
      // proves the request was accepted; an unreadable envelope proves only that
      // the POST may have landed.
      if (body !== "") readProviderJson(providerDetail.sumup(), body);
    },
  };
};
