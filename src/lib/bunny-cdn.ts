/**
 * Bunny CDN pull zone API integration.
 * Adds a custom hostname to a pull zone and enables force SSL.
 * Only used when BUNNY_API_KEY env var is set.
 * The pull zone ID is discovered automatically by matching hostnames.
 */

import { getBunnyApiKey, getCdnHostname } from "#lib/config.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

const BUNNY_API_BASE = "https://api.bunny.net";

type BunnyApiResult =
  | { ok: true }
  | { ok: false; error: string; errorKey?: string };

const HOSTNAME_ALREADY_REGISTERED = "pullzone.hostname_already_registered";

interface BunnyHostname {
  Value: string;
}

interface BunnyPullZone {
  Id: number;
  Hostnames: BunnyHostname[];
}

interface BunnyPullZoneListResponse {
  Items: BunnyPullZone[];
  HasMoreItems: boolean;
}

/**
 * Find the pull zone ID by searching pull zones for the CDN hostname
 * (ALLOWED_DOMAIN with .bunny.run replaced by .b-cdn.net).
 */
const findPullZoneIdImpl = async (): Promise<
  { ok: true; id: number } | { ok: false; error: string }
> => {
  const cdnHostname = getCdnHostname();
  const response = await fetch(
    `${BUNNY_API_BASE}/pullzone?search=${encodeURIComponent(cdnHostname)}`,
    { headers: { AccessKey: getBunnyApiKey() } },
  );

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      error: `List pull zones failed (${response.status}): ${text}`,
    };
  }

  const data: BunnyPullZoneListResponse = await response.json();
  const zone = data.Items.find((z) =>
    z.Hostnames.some((h) => h.Value === cdnHostname)
  );

  if (!zone) {
    return {
      ok: false,
      error: `No pull zone found with hostname ${cdnHostname}`,
    };
  }

  return { ok: true, id: zone.Id };
};

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
  } catch { /* use raw text */ }
  return { ok: false, error: `${label} failed (${response.status}): ${message}`, errorKey };
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
    headers: { AccessKey: getBunnyApiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 204 || response.ok) return { ok: true };
  return parseBunnyError(response, label);
};

/** Request a free Let's Encrypt certificate for a hostname on a pull zone. */
const loadFreeCertificate = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const url =
    `${BUNNY_API_BASE}/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(hostname)}`;

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
};

/** Validate a custom domain (delegates to bunnyCdnApi for testability). */
export const validateCustomDomain = (
  hostname: string,
): Promise<BunnyApiResult> => bunnyCdnApi.validateCustomDomain(hostname);
