import { mapNotNullish } from "#fp";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import {
  cachedClientFactory,
  createWithClient,
} from "#shared/payment-helpers.ts";
import { createStripeClient, type StripeClient } from "./client.ts";
import { stripeMock } from "./mock.ts";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  type StripeClientConfig,
  StripeProtocolError,
} from "./request.ts";

const formatErrorField =
  (label: string, type: "number" | "string") =>
  (value: unknown): string | null =>
    typeof value === type ? `${label}=${String(value)}` : null;

const STRIPE_ERROR_FIELDS = [
  { format: formatErrorField("status", "number"), key: "statusCode" },
  { format: formatErrorField("code", "string"), key: "code" },
  { format: formatErrorField("type", "string"), key: "type" },
  { format: formatErrorField("request", "string"), key: "requestId" },
] as const;
type StripeErrorField = (typeof STRIPE_ERROR_FIELDS)[number];

/** Extract privacy-safe fields without logging Stripe's raw error message. */
export const sanitizeStripeError = (error: unknown): string => {
  if (!(error instanceof Error)) return "unknown";
  const parts = mapNotNullish((field: StripeErrorField) =>
    field.format(Reflect.get(error, field.key)),
  )(STRIPE_ERROR_FIELDS);
  return parts.length > 0 ? parts.join(" ") : error.name;
};

const PRODUCTION_CONFIG = {
  maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  timeout: STRIPE_TIMEOUT_MS,
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

const runtimeConfig = (): StripeRuntimeConfig | null => {
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
  getConfig: runtimeConfig,
  isSameConfig: (a: StripeRuntimeConfig, b: StripeRuntimeConfig) =>
    a.secretKey === b.secretKey &&
    a.clientConfig.apiBase === b.clientConfig.apiBase &&
    a.clientConfig.maxNetworkRetries === b.clientConfig.maxNetworkRetries &&
    a.clientConfig.timeout === b.clientConfig.timeout,
  missingMessage: "No secret key configured, cannot create client",
  provider: "Stripe",
});

const get = (): Promise<StripeClient | null> => cache.getClient();
const run = createWithClient(get, {
  errorDetail: sanitizeStripeError,
  shouldPropagate: (error) => error instanceof StripeProtocolError,
});

/** Shared Stripe client lifecycle for payment and endpoint operations. */
export const stripeClientRuntime = { create, get, run };
