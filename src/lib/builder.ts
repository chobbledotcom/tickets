/**
 * Site builder — creates new Tickets instances via the Bunny API.
 *
 * Flow:
 * 1. Fetch latest release code from GitHub
 * 2. Create a new Bunny edge script with the code
 * 3. Set secrets: user-provided (DB_URL, DB_TOKEN), generated (DB_ENCRYPTION_KEY),
 *    and copied from host (email, wallet, ntfy, storage, DNS config)
 * 4. Test database connection
 * 5. Publish the script
 * 6. Record the built site in the local database
 */

import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { toBase64 } from "#lib/crypto/utils.ts";
import { getEnv } from "#lib/env.ts";
import { fetchText } from "#lib/fetch.ts";
import { fetchLatestRelease } from "#lib/update.ts";

/** Secrets copied from the host environment (if set) */
const HOST_SECRET_KEYS = [
  "NTFY_URL",
  "STORAGE_ZONE_NAME",
  "STORAGE_ZONE_KEY",
  "HOST_EMAIL_PROVIDER",
  "HOST_EMAIL_API_KEY",
  "HOST_EMAIL_FROM_ADDRESS",
  "BUNNY_API_KEY",
  "BUNNY_DNS_ZONE_ID",
  "BUNNY_DNS_SUBDOMAIN_SUFFIX",
  "APPLE_WALLET_PASS_TYPE_ID",
  "APPLE_WALLET_TEAM_ID",
  "APPLE_WALLET_SIGNING_CERT",
  "APPLE_WALLET_SIGNING_KEY",
  "APPLE_WALLET_WWDR_CERT",
  "GOOGLE_WALLET_ISSUER_ID",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
] as const;

export type BuildSiteInput = {
  siteName: string;
  dbUrl: string;
  dbToken: string;
};

export type BuildSiteResult =
  | { ok: true; scriptId: number; defaultHostname: string }
  | { ok: false; error: string };

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
  try {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: dbUrl, authToken: dbToken });
    await client.execute("SELECT 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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

/**
 * Build a new site: create edge script, configure secrets, publish.
 */
export const buildSite = async (
  input: BuildSiteInput,
): Promise<BuildSiteResult> => {
  const fullName = `Tickets - ${input.siteName}`;

  // 1. Fetch latest release code
  let code: string;
  try {
    const release = await fetchLatestRelease();
    if (!release.assetUrl) {
      return { ok: false, error: "No release asset found on GitHub" };
    }
    const assetResponse = await fetchText(release.assetUrl);
    if (!assetResponse.ok) {
      return {
        ok: false,
        error: `Failed to download release: ${assetResponse.status}`,
      };
    }
    code = assetResponse.text;
  } catch (e) {
    return {
      ok: false,
      error: `Failed to fetch release: ${(e as Error).message}`,
    };
  }

  // 2. Create edge script
  const createResult = await bunnyCdnApi.createEdgeScript(fullName, code);
  if (!createResult.ok) return createResult;

  const { scriptId, defaultHostname } = createResult;

  // 3. Generate encryption key
  const encryptionKey = builderApi.generateEncryptionKey();

  // 4. Set secrets
  const secrets: [string, string][] = [
    ["DB_URL", input.dbUrl],
    ["DB_TOKEN", input.dbToken],
    ["DB_ENCRYPTION_KEY", encryptionKey],
    ["BUNNY_SCRIPT_ID", String(scriptId)],
  ];

  // Copy host secrets that are set
  for (const key of HOST_SECRET_KEYS) {
    const value = getEnv(key);
    if (value) secrets.push([key, value]);
  }

  const secretErrors = await setSecrets(scriptId, secrets);
  if (secretErrors.length > 0) {
    return { ok: false, error: `Failed to set secrets: ${secretErrors[0]}` };
  }

  // 5. Publish
  const publishResult = await bunnyCdnApi.publishEdgeScript(scriptId);
  if (!publishResult.ok) return publishResult;

  return { ok: true, scriptId, defaultHostname };
};

/** Stubbable API for testing */
export const builderApi = {
  generateEncryptionKey,
  testDbConnection,
  buildSite,
};
