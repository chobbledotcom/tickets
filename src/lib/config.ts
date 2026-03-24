/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import { lazyRef } from "#fp";
import { settings } from "#lib/db/settings.ts";
import { getEnv, requireEnv } from "#lib/env.ts";
import type { PaymentProviderType } from "#lib/payments.ts";

/**
 * Get the configured payment provider type
 * Returns null if no provider is configured
 */
export const getPaymentProvider = (): PaymentProviderType | null => {
  const provider = settings.paymentProvider;
  if (provider === "stripe") return "stripe";
  if (provider === "square") return "square";
  return null;
};

/**
 * Get Stripe secret key from database (encrypted)
 * Returns null if not configured (payments disabled)
 */
export const getStripeSecretKey = (): string | null => {
  return settings.stripe.secretKey;
};

/**
 * Get Stripe webhook signing secret from database (encrypted)
 * Automatically configured when Stripe secret key is saved
 */
export const getStripeWebhookSecret = (): string | null => {
  return settings.stripe.webhookSecret;
};

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const configApi = {
  getPaymentProvider,
};

/**
 * Check if payments are enabled (any provider configured with valid keys)
 */
export const isPaymentsEnabled = (): boolean => {
  const provider = configApi.getPaymentProvider();
  if (provider === "stripe") return settings.stripe.hasKey;
  if (provider === "square") return settings.square.hasToken;
  return false;
};

/**
 * Get Square access token from database (encrypted)
 * Returns null if not configured
 */
export const getSquareAccessToken = (): string | null =>
  settings.square.accessToken;

/**
 * Get Square webhook signature key from database (encrypted)
 * Returns null if not configured
 */
export const getSquareWebhookSignatureKey = (): string | null =>
  settings.square.webhookSignatureKey;

/**
 * Get Square location ID from database
 * Returns null if not configured
 */
export const getSquareLocationId = (): string | null =>
  settings.square.locationId;

/**
 * Get Square sandbox mode setting from database
 * Returns true if sandbox mode is enabled
 */
export const getSquareSandbox = (): boolean => settings.square.sandbox;

/**
 * Get booking fee percentage from database.
 * Returns 0 if not set.
 */
export const getBookingFee = (): number =>
  Number.parseFloat(settings.bookingFee!) || 0;

/**
 * Get currency code from database
 * Defaults to GBP if not set
 */
export const getCurrencyCode = (): string => {
  return settings.currency;
};

/**
 * Get allowed domain for security validation (runtime config via Bunny secrets)
 * This is a required configuration that hardens origin validation
 */
const [getAllowedDomainOverride, setAllowedDomainOverride] = lazyRef<
  string | null
>(() => null);

export const getAllowedDomain = (): string =>
  getAllowedDomainOverride() ?? requireEnv("ALLOWED_DOMAIN");

/** Reset cached allowed domain value (for testing and cache invalidation) */
export const resetAllowedDomain = (): void => setAllowedDomainOverride(null);

/**
 * Explicitly set allowed domain (for testing).
 * Bypasses Deno.env to avoid races between parallel test workers.
 */
export const setAllowedDomainForTest = (domain: string): void =>
  setAllowedDomainOverride(domain);

/**
 * Effective domain: custom_domain (from DB) if set, otherwise ALLOWED_DOMAIN.
 * Loaded async once per request via loadEffectiveDomain(), then read
 * synchronously via getEffectiveDomain().
 */
const effectiveDomainState = { domain: null as string | null };

/** Load the effective domain from DB (call early in request pipeline). */
export const loadEffectiveDomain = (): string => {
  const custom = settings.customDomain;
  const validated = custom ? settings.customDomainLastValidated : null;
  effectiveDomainState.domain =
    custom && validated ? custom : getAllowedDomain();
  return effectiveDomainState.domain;
};

/** Get the effective domain synchronously (falls back to ALLOWED_DOMAIN). */
export const getEffectiveDomain = (): string =>
  effectiveDomainState.domain ?? getAllowedDomain();

/** Reset effective domain cache (for testing). */
export const resetEffectiveDomain = (): void => {
  effectiveDomainState.domain = null;
};

/** Set effective domain directly (for testing). */
export const setEffectiveDomainForTest = (domain: string): void => {
  effectiveDomainState.domain = domain;
};

/**
 * Get allowed embed hosts from database (encrypted, parsed to array)
 * Returns empty array if not configured (embedding allowed from anywhere)
 */
export const getEmbedHosts = async (): Promise<string[]> => {
  const raw = settings.embedHosts;
  if (!raw) return [];
  const { parseEmbedHosts } = await import("#lib/embed-hosts.ts");
  return parseEmbedHosts(raw);
};

/**
 * Get the configured timezone synchronously from cache.
 * Safe to call from synchronous code (templates, helpers) because
 * the settings cache is populated by middleware on every request.
 */
export const getTz = (): string => settings.timezone;

/**
 * Check if initial setup has been completed
 */
export const isSetupComplete = settings.setup.isComplete;

/**
 * Check if Bunny CDN pull zone management is enabled
 * Requires BUNNY_API_KEY to be set
 */
export const isBunnyCdnEnabled = (): boolean => !!getEnv("BUNNY_API_KEY");

/**
 * Get the Bunny CDN API key from environment
 */
export const getBunnyApiKey = (): string => requireEnv("BUNNY_API_KEY");

/**
 * Get the CDN hostname derived from ALLOWED_DOMAIN.
 * Replaces ".bunny.run" with ".b-cdn.net" for the CNAME target.
 */
export const getCdnHostname = (): string =>
  getAllowedDomain().replace(/\.bunny\.run$/, ".b-cdn.net");
