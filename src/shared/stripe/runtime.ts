import { lazyRef, mapNotNullish } from "#fp";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import {
  cachedClientFactory,
  createWithClient,
} from "#shared/payment-helpers.ts";
import {
  createStripeClient,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  type StripeClient,
  type StripeClientConfig,
} from "./client.ts";

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

const mockConfig = (): StripeClientConfig | undefined => {
  const host = getEnv("STRIPE_MOCK_HOST");
  if (!host) return;
  const port = Number.parseInt(getEnv("STRIPE_MOCK_PORT") || "12111", 10);
  return {
    ...PRODUCTION_CONFIG,
    apiBase: `http://${host}:${port}`,
    maxNetworkRetries: 0,
  };
};

const [getMockConfig, setMockConfig] = lazyRef<StripeClientConfig | undefined>(
  mockConfig,
);

const create = (secretKey: string): StripeClient => {
  const config = getMockConfig();
  return createStripeClient(
    secretKey,
    config === undefined ? PRODUCTION_CONFIG : config,
  );
};

const cache = cachedClientFactory({
  create,
  getConfig: () => settings.stripe.secretKey || null,
  isSameConfig: (a: string, b: string) => a === b,
  missingMessage: "No secret key configured, cannot create client",
  provider: "Stripe",
});

const get = (): Promise<StripeClient | null> => cache.getClient();
const run = createWithClient(get, sanitizeStripeError);
const reset = (): void => {
  cache.reset();
  setMockConfig(null);
};

/** Shared Stripe client lifecycle for payment and endpoint operations. */
export const stripeClientRuntime = { create, get, reset, run };
