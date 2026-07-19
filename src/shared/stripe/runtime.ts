import { lazyRef } from "#fp";
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

/** Extract privacy-safe fields without logging Stripe's raw error message. */
export const sanitizeStripeError = (error: unknown): string => {
  if (!(error instanceof Error)) return "unknown";
  const parts: string[] = [];
  if ("statusCode" in error && typeof error.statusCode === "number") {
    parts.push(`status=${error.statusCode}`);
  }
  if ("code" in error && typeof error.code === "string") {
    parts.push(`code=${error.code}`);
  }
  if ("type" in error && typeof error.type === "string") {
    parts.push(`type=${error.type}`);
  }
  if ("requestId" in error && typeof error.requestId === "string") {
    parts.push(`request=${error.requestId}`);
  }
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
