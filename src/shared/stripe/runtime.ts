import { settings } from "#db/settings.ts";
import { compact } from "#fp";
import {
  checkoutErrorFrom,
  type ProviderCheckoutError,
} from "#payment/checkout-failure.ts";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { getEnv } from "#shared/env.ts";
import {
  cachedClientFactory,
  createWithClient,
} from "#shared/payment-helpers.ts";
import { createStripeClient, type StripeClient } from "./client.ts";
import { stripeMock } from "./mock.ts";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  type StripeClientConfig,
} from "./request.ts";

const labelled = (
  label: string,
  value: number | string | undefined,
): string | null => (value === undefined ? null : `${label}=${value}`);

/** Extract privacy-safe fields without logging Stripe's raw error message.
 * The fields are typed on the transport error now, so this reads them rather
 * than reflecting over the error by key name. */
export const sanitizeStripeError = (error: unknown): string => {
  if (!(error instanceof ProviderTransportError)) {
    return error instanceof Error ? error.name : "unknown";
  }
  const stripe = error.detail.provider === "stripe" ? error.detail : undefined;
  const parts = compact([
    labelled("status", error.facts.statusCode),
    labelled("code", stripe?.code),
    labelled("type", stripe?.type),
    labelled("request", stripe?.requestId),
  ]);
  return parts.length > 0 ? parts.join(" ") : error.name;
};

const PRODUCTION_CONFIG = {
  maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  timeout: PROVIDER_TIMEOUT_MS,
} satisfies StripeClientConfig;

interface StripeRuntimeConfig {
  clientConfig: StripeClientConfig;
  secretKey: string;
}

const mockConfig = (): StripeClientConfig | undefined => {
  const host = getEnv("STRIPE_MOCK_HOST");
  if (!host) return;
  const port = stripeMock.port(getEnv("STRIPE_MOCK_PORT"));
  return {
    ...PRODUCTION_CONFIG,
    apiBase: `http://${host}:${port}`,
    maxNetworkRetries: 0,
  };
};

const requestConfig = (maxNetworkRetries?: number): StripeClientConfig => {
  const configured = mockConfig() ?? PRODUCTION_CONFIG;
  return maxNetworkRetries === undefined
    ? configured
    : { ...configured, maxNetworkRetries };
};

const create = (secretKey: string, maxNetworkRetries?: number): StripeClient =>
  createStripeClient(secretKey, requestConfig(maxNetworkRetries));

/**
 * Resolve the active Stripe runtime config, or null when no secret key is
 * configured. The `OrNull` suffix marks the null result as a deliberate,
 * expected absence — the caller (cachedClientFactory) treats it as
 * "provider unconfigured" and skips client creation.
 */
const runtimeConfigOrNull = (): StripeRuntimeConfig | null => {
  const secretKey = settings.stripe.secretKey;
  if (!secretKey) return null;
  return {
    clientConfig: requestConfig(),
    secretKey,
  };
};

const cache = cachedClientFactory({
  create: (config: StripeRuntimeConfig) =>
    createStripeClient(config.secretKey, config.clientConfig),
  getConfig: runtimeConfigOrNull,
  isSameConfig: (a: StripeRuntimeConfig, b: StripeRuntimeConfig) =>
    a.secretKey === b.secretKey &&
    a.clientConfig.apiBase === b.clientConfig.apiBase &&
    a.clientConfig.maxNetworkRetries === b.clientConfig.maxNetworkRetries &&
    a.clientConfig.timeout === b.clientConfig.timeout,
  missingMessage: "No secret key configured, cannot create client",
  provider: "Stripe",
});

const get = (): Promise<StripeClient | null> => cache.getClient();
const closedCheckoutError = (error: unknown): ProviderCheckoutError => {
  if (!(error instanceof ProviderTransportError)) throw error;
  return checkoutErrorFrom("stripe", error.facts);
};

const runCheckout = createWithClient(get, {
  replaceError: closedCheckoutError,
});

/** Shared Stripe client lifecycle for payment and endpoint operations. */
export const stripeClientRuntime = { create, get, runCheckout };
