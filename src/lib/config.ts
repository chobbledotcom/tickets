/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import { settings } from "#lib/db/settings.ts";
import { getEnv, requireEnv } from "#lib/env.ts";

/**
 * Check if payments are enabled (any provider configured with valid keys)
 */
export const isPaymentsEnabled = (): boolean => {
  const provider = settings.paymentProvider;
  if (provider === "stripe") return settings.stripe.hasKey;
  if (provider === "square") return settings.square.hasToken;
  return false;
};

/**
 * Get booking fee percentage from database.
 * Returns 0 if not set.
 */
export const getBookingFee = (): number =>
  Number.parseFloat(settings.bookingFee) || 0;

/**
 * Effective domain: custom_domain (from DB) if set, otherwise the request's
 * own hostname. Loaded once per request via loadEffectiveDomain(), then read
 * synchronously via getEffectiveDomain().
 */
const effectiveDomainState = { domain: null as string | null };

/** Load the effective domain from DB, falling back to the request URL hostname. */
export const loadEffectiveDomain = (requestUrl: string): string => {
  const custom = settings.customDomain;
  const validated = custom ? settings.customDomainLastValidated : null;
  effectiveDomainState.domain =
    custom && validated ? custom : new URL(requestUrl).hostname;
  return effectiveDomainState.domain;
};

/** Get the effective domain synchronously (must call loadEffectiveDomain first). */
export const getEffectiveDomain = (): string =>
  effectiveDomainState.domain ?? "localhost";

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
 * Check if Bunny CDN pull zone management is enabled
 * Requires both BUNNY_API_KEY and BUNNY_SCRIPT_ID to be set
 */
export const isBunnyCdnEnabled = (): boolean =>
  !!getEnv("BUNNY_API_KEY") && !!getEnv("BUNNY_SCRIPT_ID");

/**
 * Get the Bunny CDN API key from environment
 */
export const getBunnyApiKey = (): string => requireEnv("BUNNY_API_KEY");

/**
 * Get the Bunny Edge Script ID from environment
 */
export const getBunnyScriptId = (): string => requireEnv("BUNNY_SCRIPT_ID");
