/**
 * Bunny CDN pull zone API integration.
 * Adds a custom hostname to a pull zone and enables force SSL.
 * Only used when BUNNY_API_KEY and BUNNY_SCRIPT_ID env vars are set.
 * The pull zone is discovered via the Edge Script API, not request hostname.
 */

import { getBunnyApiKey, getBunnyScriptId } from "#lib/config.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

const BUNNY_API_BASE = "https://api.bunny.net";

type BunnyApiResult =
  | { ok: true }
  | { ok: false; error: string; errorKey?: string };

type CdnHostnameResult =
  | { ok: true; hostname: string }
  | { ok: false; error: string };

const HOSTNAME_ALREADY_REGISTERED = "pullzone.hostname_already_registered";

interface EdgeScriptLinkedPullZone {
  Id: number;
  PullZoneName: string;
  DefaultHostname: string;
}

interface EdgeScriptResponse {
  Id: number;
  DefaultHostname: string;
  LinkedPullZones: EdgeScriptLinkedPullZone[];
}

/**
 * Fetch the edge script details from the Bunny API using BUNNY_SCRIPT_ID.
 * Returns the DefaultHostname and LinkedPullZones.
 */
const getEdgeScriptImpl = async (): Promise<
  | { ok: true; data: EdgeScriptResponse }
  | { ok: false; error: string; errorKey?: string }
> => {
  const scriptId = getBunnyScriptId();
  const response = await fetch(
    `${BUNNY_API_BASE}/compute/script/${encodeURIComponent(scriptId)}`,
    { headers: { AccessKey: getBunnyApiKey() } },
  );

  if (!response.ok) {
    return parseBunnyError(response, "Get edge script");
  }

  const data: EdgeScriptResponse = await response.json();
  return { ok: true, data };
};

/** Map edge script data to a result, returning early on API error. */
const withEdgeScript = async <T>(
  fn: (data: EdgeScriptResponse) => T,
): Promise<T | { ok: false; error: string; errorKey?: string }> => {
  const result = await bunnyCdnApi.getEdgeScript();
  if (!result.ok) return result;
  return fn(result.data);
};

/**
 * Find the pull zone ID via the edge script's linked pull zones.
 */
const findPullZoneIdImpl = (): Promise<
  { ok: true; id: number } | { ok: false; error: string; errorKey?: string }
> =>
  withEdgeScript((data) => {
    const zone = data.LinkedPullZones[0];
    if (!zone) {
      return {
        ok: false as const,
        error: `Edge script ${getBunnyScriptId()} has no linked pull zones`,
      };
    }
    return { ok: true as const, id: zone.Id };
  });

/**
 * Get the CDN hostname (DefaultHostname) from the edge script.
 * This is the stable hostname for CNAME targets, independent of request URL.
 */
const getCdnHostnameImpl = (): Promise<CdnHostnameResult> =>
  withEdgeScript((data) => ({
    ok: true as const,
    hostname: data.DefaultHostname,
  }));

/** Parse a Bunny API error response into a BunnyApiResult. */
const parseBunnyError = async (
  response: Response,
  label: string,
): Promise<BunnyApiResult & { ok: false }> => {
  const text = await response.text();
  let message = text;
  let errorKey: string | undefined;
  try {
    const json = JSON.parse(text);
    if (json.Message) message = json.Message;
    if (json.ErrorKey) errorKey = json.ErrorKey;
  } catch {
    /* use raw text */
  }
  return {
    ok: false,
    error: `${label} failed (${response.status}): ${message}`,
    errorKey,
  };
};

/** POST to a Bunny CDN pull zone endpoint with JSON body. */
const pullZonePost = async (
  pullZoneId: number,
  action: string,
  body: Record<string, unknown>,
  label: string,
): Promise<BunnyApiResult> => {
  const url = `${BUNNY_API_BASE}/pullzone/${pullZoneId}/${action}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      AccessKey: getBunnyApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 204 || response.ok) return { ok: true };
  return parseBunnyError(response, label);
};

/** Request a free Let's Encrypt certificate for a hostname on a pull zone. */
const loadFreeCertificate = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const url = `${BUNNY_API_BASE}/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(hostname)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { AccessKey: getBunnyApiKey() },
  });

  if (response.ok) return { ok: true };
  return parseBunnyError(response, "Load free certificate");
};

/**
 * Validate a custom domain by adding it to the Bunny CDN pull zone
 * and enabling force SSL. Returns success or an error message.
 */
const validateCustomDomainImpl = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const zoneResult = await bunnyCdnApi.findPullZoneId();
  if (!zoneResult.ok) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: zoneResult.error });
    return zoneResult;
  }

  const pullZoneId = zoneResult.id;

  const hostnameResult = await pullZonePost(
    pullZoneId,
    "addHostname",
    { Hostname: hostname },
    "Add hostname",
  );
  if (
    !hostnameResult.ok &&
    hostnameResult.errorKey !== HOSTNAME_ALREADY_REGISTERED
  ) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: hostnameResult.error });
    return hostnameResult;
  }

  const certResult = await loadFreeCertificate(hostname);
  if (!certResult.ok) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: certResult.error });
    return certResult;
  }

  const sslResult = await pullZonePost(
    pullZoneId,
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
  findPullZoneId: findPullZoneIdImpl,
  getEdgeScript: getEdgeScriptImpl,
  getCdnHostname: getCdnHostnameImpl,
};

/** Validate a custom domain (delegates to bunnyCdnApi for testability). */
export const validateCustomDomain = (
  hostname: string,
): Promise<BunnyApiResult> => bunnyCdnApi.validateCustomDomain(hostname);

/** Get CDN hostname (delegates to bunnyCdnApi for testability). */
export const getCdnHostname = (): Promise<CdnHostnameResult> =>
  bunnyCdnApi.getCdnHostname();
