/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import { settings } from "#db/settings.ts";
import { getEnv, requireEnv } from "#shared/env.ts";
import { paymentProviderHasCredentials } from "#shared/payment-provider-status.ts";
import { slugify } from "#shared/slug.ts";
import type { PaymentProviderType } from "#types";

/**
 * Pick the value for the active payment provider from a per-provider set, or
 * `null` when no provider is active. The set is keyed by the provider union,
 * so a caller cannot forget a provider: leaving one out is a compile error at
 * the call site rather than a silent `null` on a live site.
 */
export const providerValue = <T>(
  provider: PaymentProviderType | null,
  values: Readonly<Record<PaymentProviderType, T>>,
): T | null => (provider === null ? null : values[provider]);

/** Whether an active provider has the credentials a sale needs. */
export const isPaymentsEnabled = (): boolean => {
  const provider = settings.paymentProvider;
  return provider !== null && paymentProviderHasCredentials(provider);
};

/**
 * Get booking fee percentage from database.
 * Returns 0 if not set.
 */
export const getBookingFee = (): number =>
  Number.parseFloat(settings.bookingFee) || 0;

/**
 * The domain used before any request has resolved a real one — and the single
 * place the "localhost" fallback lives. The effective domain is seeded to this
 * at module load and reset to it between tests, so it is always a real string.
 */
const DEFAULT_DOMAIN = "localhost";

/**
 * Effective domain: custom_domain (from DB) if set, otherwise the request's
 * own hostname. Loaded once per request via loadEffectiveDomain(), then read
 * synchronously via getEffectiveDomain(). Never null — it starts at
 * DEFAULT_DOMAIN and is refined as each request resolves its real host.
 */
const effectiveDomainState = { domain: DEFAULT_DOMAIN };

const isIpv4Loopback = (domain: string): boolean => {
  const parts = domain.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => {
      const value = Number(part);
      return /^\d+$/.test(part) && value >= 0 && value <= 255;
    })
  );
};

const isLocalDevelopmentHost = (domain: string): boolean =>
  domain === DEFAULT_DOMAIN ||
  domain.endsWith(".localhost") ||
  domain === "[::1]" ||
  domain === "::1" ||
  isIpv4Loopback(domain);

/** Load the effective domain from DB, falling back to the request URL hostname. */
export const loadEffectiveDomain = (requestUrl: URL): string => {
  const custom = settings.customDomain;
  const validated = custom ? settings.customDomainLastValidated : null;
  if (custom && validated) {
    effectiveDomainState.domain = custom;
  } else if (settings.bunnySubdomain) {
    effectiveDomainState.domain = settings.bunnySubdomain;
  } else {
    seedEffectiveDomainHost(requestUrl);
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
export const seedEffectiveDomainHost = (requestUrl: URL): void => {
  effectiveDomainState.domain = requestUrl.hostname;
};

/** Get the effective domain synchronously; DEFAULT_DOMAIN until a request resolves a real one. */
export const getEffectiveDomain = (): string => effectiveDomainState.domain;

/**
 * Whether we are serving a real, resolved host rather than the default. Gates
 * HTTPS-only behaviour — Secure/`__Host-` cookies and the HSTS header — which
 * must stay off for local development on DEFAULT_DOMAIN.
 */
export const isSecureMode = (): boolean =>
  !isLocalDevelopmentHost(effectiveDomainState.domain);

/** Reset effective domain cache back to the default (for testing). */
export const resetEffectiveDomain = (): void => {
  effectiveDomainState.domain = DEFAULT_DOMAIN;
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

/** True only when every named environment variable carries a value. Each
 * "is this integration set up" answer below is one of these, so a new one
 * names its variables rather than writing the check again. */
const allEnvSet =
  (...names: string[]): (() => boolean) =>
  (): boolean =>
    names.every((name) => !!getEnv(name));

/**
 * Check if Bunny CDN pull zone management is enabled
 * Requires both BUNNY_API_KEY and BUNNY_SCRIPT_ID to be set
 */
export const isBunnyCdnEnabled = allEnvSet("BUNNY_API_KEY", "BUNNY_SCRIPT_ID");

/**
 * Get the Bunny CDN API key from environment
 */
export const getBunnyApiKey = (): string => requireEnv("BUNNY_API_KEY");

/**
 * Check if Bunny DNS subdomain feature is enabled.
 * Requires BUNNY_API_KEY and BUNNY_DNS_ZONE_ID to be set.
 */
export const isBunnyDnsEnabled = allEnvSet(
  "BUNNY_API_KEY",
  "BUNNY_DNS_ZONE_ID",
);

/** Check if the Bunny hosted database provider is enabled (requires BUNNY_API_KEY). */
export const isBunnyDbEnabled = allEnvSet("BUNNY_API_KEY");

/** Check if this instance can build other sites. */
export const isBuilderEnabled = (): boolean =>
  getEnv("CAN_BUILD_SITES") === "true";

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
export const isBotpoisonEnabled = allEnvSet(
  "BOTPOISON_PUBLIC_KEY",
  "BOTPOISON_SECRET_KEY",
);

/**
 * Whether the inter-instance site-credentials endpoint is enabled. Off unless
 * MAIN_INSTANCE_KEY is set, so a non-builder instance never exposes it. The key
 * is a high-entropy shared secret the operator passes to the upgrade workflow at
 * trigger time (it is never stored in GitHub).
 */
export const isInstanceApiEnabled = allEnvSet("MAIN_INSTANCE_KEY");

/** The shared secret authorizing the inter-instance site-credentials endpoint. */
export const getMainInstanceKey = (): string => requireEnv("MAIN_INSTANCE_KEY");

/** Check if Deno Deploy hosting has its token, organization ID, and domain slug. */
export const isDenoDeployEnabled = allEnvSet(
  "DENO_DEPLOY_TOKEN",
  "DENO_DEPLOY_ORG_ID",
  "DENO_DEPLOY_ORG_SLUG",
);

/** Get the Deno Deploy API token from environment. */
export const getDenoDeployToken = (): string => requireEnv("DENO_DEPLOY_TOKEN");

/** Get the Deno Deploy organization ID from environment. */
export const getDenoDeployOrgId = (): string =>
  requireEnv("DENO_DEPLOY_ORG_ID");

/** Get the Deno Deploy organization slug used in managed production domains. */
export const getDenoDeployOrgSlug = (): string =>
  requireEnv("DENO_DEPLOY_ORG_SLUG");

/** DEFAULT_DB_HOST's provider: "turso" when set to it, "bunny" otherwise. */
export const getDefaultDbProvider = (): "bunny" | "turso" =>
  getEnv("DEFAULT_DB_HOST") === "turso" ? "turso" : "bunny";

/** Whether Turso hosting has its API token, organization, and group set. */
export const isTursoEnabled = allEnvSet(
  "TURSO_API_TOKEN",
  "TURSO_ORGANIZATION",
  "TURSO_GROUP",
);

/** Get the Turso API token from environment. */
export const getTursoApiToken = (): string => requireEnv("TURSO_API_TOKEN");

/** Get the Turso organization name from environment. */
export const getTursoOrganization = (): string =>
  requireEnv("TURSO_ORGANIZATION");

/** Get the Turso database group from environment. */
export const getTursoGroup = (): string => requireEnv("TURSO_GROUP");

/**
 * Sanitize a site name into a valid provider resource slug: the shared
 * {@link slugify}, capped at `maxLength` with any hyphen the cut left trimmed.
 */
export const slugifyForProvider = (name: string, maxLength: number): string =>
  slugify(name).slice(0, maxLength).replace(/-+$/, "");

/** Turns a site name into a provider-safe slug. */
type SlugRule = (name: string) => string;

/** A provider's resource-name rule: the provider slug capped at `maxLength`,
 * padded with `pad` when it lands under `minLength` (a provider that only
 * needs a non-empty name sets `minLength` to 1 and reads `pad` as the
 * empty-name fallback). */
const providerSlugRule =
  ({
    maxLength,
    minLength,
    pad,
  }: {
    maxLength: number;
    minLength: number;
    pad: string;
  }): SlugRule =>
  (name) => {
    const slug = slugifyForProvider(name, maxLength);
    return slug.length >= minLength
      ? slug
      : `${slug}${pad}`.slice(0, maxLength);
  };

/** Deno Deploy app names: 3–32 chars, lowercase letters, numbers, hyphens. */
export const denoDeployAppSlug: SlugRule = providerSlugRule({
  maxLength: 32,
  minLength: 3,
  pad: "app",
});

/** Turso database names: non-empty, at most 63 chars. */
export const tursoDatabaseSlug: SlugRule = providerSlugRule({
  maxLength: 63,
  minLength: 1,
  pad: "db",
});
