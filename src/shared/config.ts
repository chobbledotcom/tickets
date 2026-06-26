/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import { settings } from "#shared/db/settings.ts";
import { getEnv, requireEnv } from "#shared/env.ts";

/**
 * Check if payments are enabled (any provider configured with valid keys)
 */
export const isPaymentsEnabled = (): boolean => {
  const provider = settings.paymentProvider;
  if (provider === "stripe") return settings.stripe.hasKey;
  if (provider === "square") return settings.square.hasToken;
  if (provider === "sumup") return settings.sumup.hasKey;
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
  if (custom && validated) {
    effectiveDomainState.domain = custom;
  } else if (settings.bunnySubdomain) {
    effectiveDomainState.domain = settings.bunnySubdomain;
  } else {
    effectiveDomainState.domain = new URL(requestUrl).hostname;
  }
  return effectiveDomainState.domain;
};

/**
 * Seed the effective domain from the request's own hostname.
 *
 * loadEffectiveDomain() runs late in the request (after settings are loaded),
 * so anything that fails before it — most notably database migrations on the
 * first request after a cold boot — would otherwise read the bare "localhost"
 * fallback in error notifications. Seeding the request host early makes those
 * notifications (e.g. ntfy titles) identify the real site. The value is
 * refined later by loadEffectiveDomain() once the custom domain is known.
 */
export const seedEffectiveDomainHost = (requestUrl: string): void => {
  effectiveDomainState.domain = new URL(requestUrl).hostname;
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
  const { parseEmbedHosts } = await import("#shared/embed-hosts.ts");
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
 * Get the Bunny Edge Script ID from environment
 */
export const getBunnyScriptId = (): string => requireEnv("BUNNY_SCRIPT_ID");

/**
 * Diagnostic key gating the verbose `/health` response. Empty when unset, in
 * which case `/health` only ever returns the plain liveness reply. Holding the
 * key reveals non-private build/runtime diagnostics (commit, build time) that
 * are useful for operators but needlessly helpful to an attacker.
 */
export const getDebugKey = (): string => getEnv("DEBUG_KEY") ?? "";

/**
 * Get the Botpoison public key from environment (safe to expose to browsers).
 * Returns empty string when unset.
 */
export const getBotpoisonPublicKey = (): string =>
  getEnv("BOTPOISON_PUBLIC_KEY") ?? "";

/**
 * Get the Botpoison secret key from environment (server-side verification only).
 * Returns empty string when unset.
 */
export const getBotpoisonSecretKey = (): string =>
  getEnv("BOTPOISON_SECRET_KEY") ?? "";

/**
 * Check if Botpoison spam protection is configured.
 * Requires both BOTPOISON_PUBLIC_KEY and BOTPOISON_SECRET_KEY to be set.
 * This gates the public contact form feature.
 */
export const isBotpoisonEnabled = (): boolean =>
  !!getBotpoisonPublicKey() && !!getBotpoisonSecretKey();

/**
 * Whether the inter-instance site-credentials endpoint is enabled. Off unless
 * MAIN_INSTANCE_KEY is set, so a non-builder instance never exposes it. The key
 * is a high-entropy shared secret the operator passes to the upgrade workflow at
 * trigger time (it is never stored in GitHub).
 */
export const isInstanceApiEnabled = (): boolean =>
  !!getEnv("MAIN_INSTANCE_KEY");

/** The shared secret authorizing the inter-instance site-credentials endpoint. */
export const getMainInstanceKey = (): string => requireEnv("MAIN_INSTANCE_KEY");

/** Check if Deno Deploy hosting is enabled (requires DENO_DEPLOY_TOKEN and DENO_DEPLOY_ORG_ID). */
export const isDenoDeployEnabled = (): boolean =>
  !!getEnv("DENO_DEPLOY_TOKEN") && !!getEnv("DENO_DEPLOY_ORG_ID");

/** Get the Deno Deploy API token from environment. */
export const getDenoDeployToken = (): string => requireEnv("DENO_DEPLOY_TOKEN");

/** Get the Deno Deploy organization ID from environment. */
export const getDenoDeployOrgId = (): string =>
  requireEnv("DENO_DEPLOY_ORG_ID");

/** Check if Turso hosted database provider is enabled (requires TURSO_API_TOKEN, TURSO_ORGANIZATION, TURSO_GROUP). */
export const isTursoEnabled = (): boolean =>
  !!getEnv("TURSO_API_TOKEN") &&
  !!getEnv("TURSO_ORGANIZATION") &&
  !!getEnv("TURSO_GROUP");

/** Get the Turso API token from environment. */
export const getTursoApiToken = (): string => requireEnv("TURSO_API_TOKEN");

/** Get the Turso organization name from environment. */
export const getTursoOrganization = (): string =>
  requireEnv("TURSO_ORGANIZATION");

/** Get the Turso database group from environment. */
export const getTursoGroup = (): string => requireEnv("TURSO_GROUP");

/**
 * Sanitize a site name into a valid provider resource slug.
 * Lowercase letters, numbers, hyphens only; no leading/trailing hyphens.
 */
export const slugifyForProvider = (name: string, maxLength: number): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
