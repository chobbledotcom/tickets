/**
 * Site builder — creates new Tickets instances via the Bunny API.
 *
 * Flow:
 * 1. Fetch latest release code from GitHub
 * 1b. Auto-provision a Bunny database if dbUrl/dbToken not supplied
 * 2. Create a new Bunny edge script with the code
 * 3. Enable cookies on the linked pull zone (DisableCookies: false)
 * 4. Set secrets: DB credentials, generated DB_ENCRYPTION_KEY,
 *    and host secrets copied from the host environment
 * 5. Publish the script
 */

import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbApi, type CreateDatabaseResult } from "#shared/bunny-db.ts";
import { toBase64 } from "#shared/crypto/utils.ts";
import { getEnv } from "#shared/env.ts";
import { fetchText } from "#shared/fetch.ts";
import { withSiteDb } from "#shared/site-db.ts";
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
  /** Leave blank to auto-provision a new Bunny database via the API. */
  dbUrl?: string;
  /** Leave blank to auto-provision a new Bunny database via the API. */
  dbToken?: string;
  /**
   * Pre-built bundle source to deploy. When omitted, the latest GitHub
   * release asset is fetched (used by /admin/builder). The CLI builder
   * passes a freshly-built local bundle here.
   */
  code?: string;
};

export type BuildSiteResult =
  | {
      ok: true;
      scriptId: number;
      defaultHostname: string;
      dbUrl: string;
      dbToken: string;
    }
  | { ok: false; error: string };

type BuildSiteCredentials = Pick<CreateDatabaseResult, "dbUrl" | "dbToken">;

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

/** Set multiple secrets on a Bunny edge script, collecting errors */
const setSecrets = async (
  scriptId: number,
  secrets: [name: string, value: string][],
): Promise<string[]> => {
  const errors: string[] = [];
  for (const [name, value] of secrets) {
    const result = await bunnyCdnApi.setEdgeScriptSecret(scriptId, name, value);
    if (!result.ok) errors.push(result.error);
  }
  return errors;
};

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

/** Use supplied DB credentials or provision a new Bunny database. */
const getDbCredentials = async (
  input: BuildSiteInput,
): Promise<
  { ok: true; credentials: BuildSiteCredentials } | { ok: false; error: string }
> => {
  if (input.dbUrl) {
    return {
      credentials: { dbToken: input.dbToken ?? "", dbUrl: input.dbUrl },
      ok: true,
    };
  }

  const dbResult = await builderApi.createDatabase(input.siteName);
  if (!dbResult.ok) return dbResult;
  return {
    credentials: { dbToken: dbResult.dbToken, dbUrl: dbResult.dbUrl },
    ok: true,
  };
};

/**
 * Build a new site: create edge script, configure secrets, publish.
 */
export const buildSite = async (
  input: BuildSiteInput,
): Promise<BuildSiteResult> => {
  const fullName = `Tickets - ${input.siteName}`;

  // 1. Source the bundle code: caller-supplied or latest GitHub release
  const codeResult = await getBuildCode(input);
  if (!codeResult.ok) return codeResult;

  // 1b. Auto-provision database if credentials not supplied
  const credentialsResult = await getDbCredentials(input);
  if (!credentialsResult.ok) return credentialsResult;
  const dbCredentials = credentialsResult.credentials;

  // 2. Create edge script
  const createResult = await bunnyCdnApi.createEdgeScript(
    fullName,
    codeResult.code,
  );
  if (!createResult.ok) return createResult;

  const { scriptId, pullZoneId, defaultHostname } = createResult;

  // 3. Enable cookies on the linked pull zone
  const pzResult = await bunnyCdnApi.updatePullZone(pullZoneId, {
    DisableCookies: false,
  });
  if (!pzResult.ok) return pzResult;

  // 4. Generate encryption key
  const encryptionKey = builderApi.generateEncryptionKey();

  // 5. Set secrets: base credentials plus any host secrets that are set
  const secrets: [string, string][] = [
    ["DB_URL", dbCredentials.dbUrl],
    ["DB_TOKEN", dbCredentials.dbToken],
    ["DB_ENCRYPTION_KEY", encryptionKey],
    ["BUNNY_SCRIPT_ID", String(scriptId)],
    ...collectHostSecrets(),
  ];

  // Renewal-related secrets (READ_ONLY_FROM, RENEWAL_URL) are pushed later by
  // site-assignment.ts after the site row has been created — the builder
  // itself stays renewal-agnostic.

  const secretErrors = await setSecrets(scriptId, secrets);
  if (secretErrors.length > 0) {
    return { error: `Failed to set secrets: ${secretErrors[0]}`, ok: false };
  }

  // 6. Publish
  const publishResult = await bunnyCdnApi.publishEdgeScript(scriptId);
  if (!publishResult.ok) return publishResult;

  return {
    dbToken: dbCredentials.dbToken,
    dbUrl: dbCredentials.dbUrl,
    defaultHostname,
    ok: true,
    scriptId,
  };
};

/** Stubbable API for testing */
export const builderApi = {
  buildSite,
  createDatabase: bunnyDbApi.createDatabase,
  generateEncryptionKey,
  testDbConnection,
};
