/**
 * Bunny CDN pull zone API integration.
 * Adds a custom hostname to a pull zone and enables force SSL.
 * Only used when BUNNY_API_KEY and BUNNY_PULL_ZONE_ID env vars are set.
 */

import { getBunnyApiKey, getBunnyPullZoneId } from "#lib/config.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

const BUNNY_API_BASE = "https://api.bunny.net";

type BunnyApiResult = { ok: true } | { ok: false; error: string };

/** POST to a Bunny CDN pull zone endpoint with JSON body. */
const pullZonePost = async (
  action: string,
  body: Record<string, unknown>,
  label: string,
): Promise<BunnyApiResult> => {
  const url = `${BUNNY_API_BASE}/pullzone/${getBunnyPullZoneId()}/${action}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { AccessKey: getBunnyApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 204 || response.ok) return { ok: true };

  const text = await response.text();
  return { ok: false, error: `${label} failed (${response.status}): ${text}` };
};

/**
 * Validate a custom domain by adding it to the Bunny CDN pull zone
 * and enabling force SSL. Returns success or an error message.
 */
const validateCustomDomainImpl = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const hostnameResult = await pullZonePost(
    "addHostname",
    { Hostname: hostname },
    "Add hostname",
  );
  if (!hostnameResult.ok) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: hostnameResult.error });
    return hostnameResult;
  }

  const sslResult = await pullZonePost(
    "setForceSSL",
    { Hostname: hostname, ForceSSL: true },
    "Set force SSL",
  );
  if (!sslResult.ok) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: sslResult.error });
    return sslResult;
  }

  return { ok: true };
};

/** Stubbable API for testing */
export const bunnyCdnApi = {
  validateCustomDomain: validateCustomDomainImpl,
};

/** Validate a custom domain (delegates to bunnyCdnApi for testability). */
export const validateCustomDomain = (
  hostname: string,
): Promise<BunnyApiResult> => bunnyCdnApi.validateCustomDomain(hostname);
