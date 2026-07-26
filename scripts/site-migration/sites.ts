import * as v from "valibot";
import { secureUrlCheck } from "#scripts/secure-url.ts";
import { type DatabaseHost, databaseHostFor } from "#shared/db/host.ts";

/** One site as the main instance reports it, with its database credentials. */
const SiteCredentialsSchema = v.object({
  dbToken: v.string(),
  dbUrl: v.string(),
  name: v.string(),
  scriptId: v.string(),
});

const SiteCredentialsResponseSchema = v.object({
  sites: v.array(SiteCredentialsSchema),
});

export type SiteCredentials = v.InferOutput<typeof SiteCredentialsSchema>;

/** A site plus who runs its database right now. */
export interface SiteWithHost extends SiteCredentials {
  host: DatabaseHost;
}

/** Where the list of sites comes from. */
export interface MainInstance {
  key: string;
  url: string;
}

/** The key and the database tokens are only ever sent over an encrypted link. */
const requireSecureMainSite = secureUrlCheck(new Set(["https:"]));

/** Ask the live main site for every built site and its database credentials. */
export const fetchSites = async (
  instance: MainInstance,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<SiteWithHost[]> => {
  const base = requireSecureMainSite(instance.url, "Main site address").replace(
    /\/+$/,
    "",
  );
  const response = await fetcher(`${base}/instance/site-credentials`, {
    headers: { Authorization: `Bearer ${instance.key}` },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `The main site refused the request: ${response.status} ${response.statusText}`,
    );
  }
  const body = v.parse(SiteCredentialsResponseSchema, await response.json());
  return body.sites.map((site) => ({
    ...site,
    host: databaseHostFor(site.dbUrl),
  }));
};
