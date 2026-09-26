/**
 * The hosting-provider layer everything that touches a built site's
 * infrastructure shares: which provider a site runs on, and whether the host
 * holds what it takes to reach a site on it.
 */

import type { HostingProvider } from "#db/built-sites/types.ts";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { denoHostingProvider } from "#shared/deno-deploy-api.ts";
import { getEnv } from "#shared/env.ts";
import type { HostingProviderApi } from "#shared/provider-types.ts";

const HOSTING_PROVIDERS: Record<HostingProvider, HostingProviderApi> = {
  bunny: bunnyHostingProvider,
  deno: denoHostingProvider,
};

export const resolveHostingProvider = (
  provider: HostingProvider,
): HostingProviderApi => HOSTING_PROVIDERS[provider];

/** The result of {@link siteHostingAccess}: the hosting id on success. */
export type SiteHostingAccess =
  | { ok: true; hostingId: string }
  | { ok: false; error: string };

/**
 * A built site can only be reached on its hosting provider when it has a
 * hosting ID and the host holds the provider's API key. `blocked` finishes
 * the error sentence — e.g. "its secrets can't be read".
 */
export const siteHostingAccess = (
  site: { hostingId: string; hostingProvider: HostingProvider },
  blocked: string,
): SiteHostingAccess => {
  if (!site.hostingId) {
    return { error: `This site has no hosting ID, so ${blocked}.`, ok: false };
  }
  const { configEnvVar } = resolveHostingProvider(site.hostingProvider);
  if (!getEnv(configEnvVar)) {
    return {
      error: `${configEnvVar} is not configured on this host, so ${blocked}.`,
      ok: false,
    };
  }
  return { hostingId: site.hostingId, ok: true };
};
