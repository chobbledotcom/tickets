/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import { lazyRef } from "#fp";
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
  Number.parseFloat(settings.bookingFee!) || 0;

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
  if (custom && validated) {
    effectiveDomainState.domain = custom;
  } else if (settings.bunnySubdomain) {
    effectiveDomainState.domain = settings.bunnySubdomain;
  } else {
    effectiveDomainState.domain = getAllowedDomain();
  }
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
 * Check if Bunny CDN pull zone management is enabled
 * Requires BUNNY_API_KEY to be set
 */
export const isBunnyCdnEnabled = (): boolean => !!getEnv("BUNNY_API_KEY");

/**
 * Get the Bunny CDN API key from environment
 */
export const getBunnyApiKey = (): string => requireEnv("BUNNY_API_KEY");

/**
 * Check if Bunny DNS subdomain feature is enabled.
 * Requires BUNNY_API_KEY and BUNNY_DNS_ZONE_ID to be set.
 */
export const isBunnyDnsEnabled = (): boolean =>
  !!getEnv("BUNNY_API_KEY") && !!getEnv("BUNNY_DNS_ZONE_ID");

/** Get the Bunny DNS zone ID from environment */
export const getBunnyDnsZoneId = (): string => requireEnv("BUNNY_DNS_ZONE_ID");

/** Get the Bunny DNS subdomain suffix (e.g. ".tickets") from environment */
export const getBunnyDnsSubdomainSuffix = (): string =>
  getEnv("BUNNY_DNS_SUBDOMAIN_SUFFIX") ?? "";

/**
 * Get the CDN hostname derived from ALLOWED_DOMAIN.
 * Replaces ".bunny.run" with ".b-cdn.net" for the CNAME target.
 */
export const getCdnHostname = (): string =>
  getAllowedDomain().replace(/\.bunny\.run$/, ".b-cdn.net");
