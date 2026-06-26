/**
 * Site builder — creates new Tickets instances via Bunny or Deno Deploy APIs.
 *
 * Flow (Bunny hosting):
 * 1. Fetch latest release code from GitHub
 * 1b. Auto-provision a database (Bunny or Turso) if dbUrl/dbToken not supplied
 * 2. Create a new Bunny edge script with the code
 * 3. Enable cookies on the linked pull zone (DisableCookies: false)
 * 4. Set secrets: DB credentials, generated DB_ENCRYPTION_KEY,
 *    BUNNY_SCRIPT_ID, and host secrets copied from the host environment
 * 5. Publish the script
 *
 * Flow (Deno Deploy hosting):
 * 1. Fetch latest release code from GitHub
 * 1b. Auto-provision a database (Bunny or Turso) if dbUrl/dbToken not supplied
 * 2. Create a new Deno Deploy app
 * 3. Set env vars: DB credentials, DB_ENCRYPTION_KEY, and host secrets
 * 4. Deploy the code
 */

import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { toBase64 } from "#shared/crypto/utils.ts";
import type { DbProvider, HostingProvider } from "#shared/db/built-sites.ts";
import { denoHostingProvider } from "#shared/deno-deploy-api.ts";
import { getEnv } from "#shared/env.ts";
import { fetchText } from "#shared/fetch.ts";
import type { HostingProviderApi } from "#shared/provider-types.ts";
import { withSiteDb } from "#shared/site-db.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";
import { fetchLatestRelease } from "#shared/update.ts";

/**
 * Secrets copied from the host environment to every built site (when set).
 * `hostInfra: true` tags account-/infrastructure-level credentials (the Bunny
 * account key, shared storage, host email, wallet signing material). They are
 * copied deliberately — built sites are trusted clones on the operator's own
 * infrastructure — but the backfill UI surfaces them distinctly so the operator
 * stays aware. Keeping sensitivity here, on the single source list, stops it
 * drifting from a hand-maintained parallel list.
 */
type HostSecret = { name: string; hostInfra?: boolean };

const HOST_SECRETS: readonly HostSecret[] = [
  { name: "NTFY_URL" },
  { name: "SENTRY_URL" },
  { name: "ADMIN_EMAIL_ADDRESS" },
  { hostInfra: true, name: "STORAGE_ZONE_NAME" },
  { hostInfra: true, name: "STORAGE_ZONE_KEY" },
  { name: "HOST_EMAIL_PROVIDER" },
  { hostInfra: true, name: "HOST_EMAIL_API_KEY" },
  { name: "HOST_EMAIL_FROM_ADDRESS" },
  { hostInfra: true, name: "BUNNY_API_KEY" },
  { hostInfra: true, name: "BUNNY_DNS_ZONE_ID" },
  { name: "BUNNY_DNS_SUBDOMAIN_SUFFIX" },
  { name: "APPLE_WALLET_PASS_TYPE_ID" },
  { name: "APPLE_WALLET_TEAM_ID" },
  { hostInfra: true, name: "APPLE_WALLET_SIGNING_CERT" },
  { hostInfra: true, name: "APPLE_WALLET_SIGNING_KEY" },
  { hostInfra: true, name: "APPLE_WALLET_WWDR_CERT" },
  { name: "GOOGLE_WALLET_ISSUER_ID" },
  { name: "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL" },
  { hostInfra: true, name: "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY" },
];

/** All host secret names copied to built sites. */
export const HOST_SECRET_KEYS: readonly string[] = HOST_SECRETS.map(
  (s) => s.name,
);

/** The host-level infrastructure credential names among HOST_SECRET_KEYS — the
 * high-privilege subset the backfill UI flags. Derived from the same list, so
 * it can't drift out of sync. */
export const HOST_INFRA_SECRET_KEYS: readonly string[] = HOST_SECRETS.filter(
  (s) => s.hostInfra,
).map((s) => s.name);

export type BuildSiteInput = {
  siteName: string;
  /** Leave blank to auto-provision a new database via the API. */
  dbUrl?: string;
  /** Leave blank to auto-provision a new database via the API. */
  dbToken?: string;
  /**
   * Pre-built bundle source to deploy. When omitted, the latest GitHub
   * release asset is fetched (used by /admin/builder). The CLI builder
   * passes a freshly-built local bundle here.
   */
  code?: string;
  /** Hosting provider — defaults to "bunny". */
  hostingProvider?: HostingProvider;
  /** Database provider (when auto-provisioning) — defaults to "bunny". */
  dbProvider?: DbProvider;
};

export type BuildSiteResult =
  | {
      ok: true;
      /** Provider-specific identifier: Bunny script ID (as string) or Deno app ID. */
      hostingId: string;
      defaultHostname: string;
      dbUrl: string;
      dbToken: string;
      hostingProvider: HostingProvider;
      dbProvider: DbProvider;
    }
  | { ok: false; error: string };

type BuildSiteCredentials = { dbUrl: string; dbToken: string };

/** Generate a random 32-byte base64 encryption key */
export const generateEncryptionKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes);
};

/** Test a libsql database connection by running a simple query */
export const testDbConnection = async (
  dbUrl: string,
  dbToken: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const result = await withSiteDb({ dbToken, dbUrl }, (client) =>
    client.execute("SELECT 1"),
  );
  return result.ok ? { ok: true } : { error: result.error, ok: false };
};

/**
 * Collect the host-environment secrets that are currently set, as [name, value]
 * pairs. These are copied onto every freshly built site, and backfilled onto
 * existing sites that are missing them (see #shared/site-secrets.ts).
 */
export const collectHostSecrets = (): [string, string][] => {
  const secrets: [string, string][] = [];
  for (const key of HOST_SECRET_KEYS) {
    const value = getEnv(key);
    if (value) secrets.push([key, value]);
  }
  return secrets;
};

/** Build the base per-site secrets: DB credentials and encryption key. */
const buildBaseSecrets = (
  dbCredentials: BuildSiteCredentials,
  encryptionKey: string,
): [string, string][] => [
  ["DB_URL", dbCredentials.dbUrl],
  ["DB_TOKEN", dbCredentials.dbToken],
  ["DB_ENCRYPTION_KEY", encryptionKey],
];

/** Source the bundle code from input or the latest GitHub release. */
const getBuildCode = async (
  input: BuildSiteInput,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> => {
  if (input.code !== undefined) return { code: input.code, ok: true };

  try {
    const release = await fetchLatestRelease();
    if (!release.assetUrl) {
      return { error: "No release asset found on GitHub", ok: false };
    }
    const assetResponse = await fetchText(release.assetUrl);
    if (!assetResponse.ok) {
      return {
        error: `Failed to download release: ${assetResponse.status}`,
        ok: false,
      };
    }
    return { code: assetResponse.text, ok: true };
  } catch (e) {
    return {
      error: `Failed to fetch release: ${(e as Error).message}`,
      ok: false,
    };
  }
};

/** Use supplied DB credentials or provision a new database via the selected provider. */
const getDbCredentials = async (
  input: BuildSiteInput,
): Promise<
  | {
      ok: true;
      credentials: BuildSiteCredentials;
      dbProvider: DbProvider;
    }
  | { ok: false; error: string }
> => {
  if (input.dbUrl) {
    return {
      credentials: { dbToken: input.dbToken ?? "", dbUrl: input.dbUrl },
      dbProvider: input.dbProvider ?? "bunny",
      ok: true,
    };
  }

  const provider = input.dbProvider ?? "bunny";
  const dbResult = await builderApi.createDatabase(input.siteName, provider);
  if (!dbResult.ok) return dbResult;
  return {
    credentials: { dbToken: dbResult.dbToken, dbUrl: dbResult.dbUrl },
    dbProvider: provider,
    ok: true,
  };
};

/**
 * Build a new site on the selected hosting provider: Bunny Edge Scripting or
 * Deno Deploy. Configures secrets/env-vars and deploys the code.
 */
const buildSiteOnProvider = async (
  input: BuildSiteInput,
  code: string,
  dbCredentials: BuildSiteCredentials,
  dbProvider: DbProvider,
  hostingProvider: HostingProvider,
): Promise<BuildSiteResult> => {
  const fullName = `Tickets - ${input.siteName}`;
  const encryptionKey = builderApi.generateEncryptionKey();
  const secrets: [string, string][] = [
    ...buildBaseSecrets(dbCredentials, encryptionKey),
    ...collectHostSecrets(),
  ];
  const result = await resolveHostingProvider(hostingProvider).createSite(
    fullName,
    code,
    secrets,
  );
  if (!result.ok) return result;
  return {
    dbProvider,
    dbToken: dbCredentials.dbToken,
    dbUrl: dbCredentials.dbUrl,
    defaultHostname: result.defaultHostname,
    hostingId: result.hostingId,
    hostingProvider,
    ok: true,
  };
};

/**
 * Build a new site: provision database if needed, create hosting, configure
 * secrets, deploy.
 */
export const buildSite = async (
  input: BuildSiteInput,
): Promise<BuildSiteResult> => {
  // 1. Source the bundle code: caller-supplied or latest GitHub release
  const codeResult = await getBuildCode(input);
  if (!codeResult.ok) return codeResult;

  // 2. Auto-provision database if credentials not supplied
  const credentialsResult = await getDbCredentials(input);
  if (!credentialsResult.ok) return credentialsResult;
  const { credentials: dbCredentials, dbProvider } = credentialsResult;

  // 3. Build on the selected hosting provider
  return buildSiteOnProvider(
    input,
    codeResult.code,
    dbCredentials,
    dbProvider,
    input.hostingProvider ?? "bunny",
  );
};

const HOSTING_PROVIDERS: Record<HostingProvider, HostingProviderApi> = {
  bunny: bunnyHostingProvider,
  deno: denoHostingProvider,
};

export const resolveHostingProvider = (
  provider: HostingProvider,
): HostingProviderApi => HOSTING_PROVIDERS[provider];

/** Dispatch database creation to the selected provider. */
function createDatabase(name: string, provider: DbProvider = "bunny") {
  if (provider === "turso") return tursoDbProvider.createDatabase(name);
  return bunnyDbProvider.createDatabase(name);
}

/** Stubbable API for testing */
export const builderApi = {
  buildSite,
  createDatabase,
  generateEncryptionKey,
  testDbConnection,
};
