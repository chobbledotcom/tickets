/**
 * Bunny CDN pull zone API integration.
 * Adds a custom hostname to a pull zone and enables force SSL.
 * Only used when BUNNY_API_KEY and BUNNY_SCRIPT_ID env vars are set.
 * The pull zone is discovered via the Edge Script API, not request hostname.
 */

import {
  getBunnyApiKey,
  getBunnyDnsSubdomainSuffix,
  getBunnyDnsZoneId,
  getBunnyScriptId,
} from "#lib/config.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { type FetchResult, fetchDrained } from "#lib/fetch.ts";

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
  const response = await fetchDrained(
    `${BUNNY_API_BASE}/compute/script/${encodeURIComponent(scriptId)}`,
    { headers: { AccessKey: getBunnyApiKey() } },
  );

  if (!response.ok) {
    return parseBunnyError(response, "Get edge script");
  }

  const data: EdgeScriptResponse = JSON.parse(response.text);
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
const toCnameTarget = (hostname: string): string =>
  hostname.replace(/^https?:\/\//, "").replace(/\.bunny\.run$/, ".b-cdn.net");

const getCdnHostnameImpl = (): Promise<CdnHostnameResult> =>
  withEdgeScript((data) => ({
    ok: true as const,
    hostname: toCnameTarget(data.DefaultHostname),
  }));

/** Return ok for a successful response or parse an error. */
const okOrError = (
  response: FetchResult,
  label: string,
): BunnyApiResult =>
  response.ok ? { ok: true } : parseBunnyError(response, label);

/** Parse a Bunny API error response into a BunnyApiResult. */
const parseBunnyError = (
  response: FetchResult,
  label: string,
): BunnyApiResult & { ok: false } => {
  let message = response.text;
  let errorKey: string | undefined;
  try {
    const json = JSON.parse(response.text);
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

  const response = await fetchDrained(url, {
    method: "POST",
    headers: {
      AccessKey: getBunnyApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return okOrError(response, label);
};

/** Request a free Let's Encrypt certificate for a hostname on a pull zone. */
const loadFreeCertificate = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const url = `${BUNNY_API_BASE}/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(hostname)}`;

  const response = await fetchDrained(url, {
    method: "GET",
    headers: { AccessKey: getBunnyApiKey() },
  });

  return okOrError(response, "Load free certificate");
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

// ---------------------------------------------------------------------------
// DNS Zone API — subdomain management
// ---------------------------------------------------------------------------

interface BunnyDnsRecord {
  Id: number;
  Type: number;
  Name: string;
  Value: string;
}

interface BunnyDnsZone {
  Id: number;
  Domain: string;
  Records: BunnyDnsRecord[];
}

/** Bunny DNS record type for CNAME */
const DNS_RECORD_TYPE_CNAME = 5;

/**
 * Get a DNS zone by ID, returning the zone domain and records.
 */
const getDnsZoneImpl = async (): Promise<
  { ok: true; zone: BunnyDnsZone } | { ok: false; error: string }
> => {
  const zoneId = getBunnyDnsZoneId();
  const response = await fetchDrained(`${BUNNY_API_BASE}/dnszone/${zoneId}`, {
    headers: { AccessKey: getBunnyApiKey() },
  });

  if (!response.ok) {
    return parseBunnyError(response, "Get DNS zone");
  }

  const zone: BunnyDnsZone = JSON.parse(response.text);
  return { ok: true, zone };
};

/**
 * Build the full subdomain record name (user choice + suffix).
 * e.g. "myevent" + ".tickets" → "myevent.tickets"
 */
export const buildSubdomainRecordName = (subdomain: string): string =>
  `${subdomain}${getBunnyDnsSubdomainSuffix()}`;

/**
 * Check whether a subdomain is available in the DNS zone.
 * Looks for any existing record with the same name.
 */
const checkSubdomainAvailableImpl = async (
  subdomain: string,
): Promise<
  | { ok: true; available: true; fullDomain: string }
  | { ok: true; available: false; fullDomain: string }
  | { ok: false; error: string }
> => {
  const zoneResult = await bunnyCdnApi.getDnsZone();
  if (!zoneResult.ok) return zoneResult;

  const recordName = buildSubdomainRecordName(subdomain);
  const fullDomain = `${recordName}.${zoneResult.zone.Domain}`;
  const taken = zoneResult.zone.Records.some((r) => r.Name === recordName);
  return { ok: true, available: !taken, fullDomain };
};

/**
 * Register a bunny subdomain: add a CNAME DNS record pointing to ALLOWED_DOMAIN,
 * then register the hostname with the CDN pull zone (SSL + force SSL).
 */
const registerBunnySubdomainImpl = async (
  subdomain: string,
): Promise<{ ok: true; fullDomain: string } | { ok: false; error: string }> => {
  // 1. Check availability
  const availCheck = await bunnyCdnApi.checkSubdomainAvailable(subdomain);
  if (!availCheck.ok) return availCheck;
  if (!availCheck.available) {
    return { ok: false, error: `Subdomain "${subdomain}" is already taken` };
  }

  const recordName = buildSubdomainRecordName(subdomain);
  const fullDomain = availCheck.fullDomain;

  // Resolve CDN hostname for CNAME target (stable .b-cdn.net, not custom domain)
  const cdnHostname = await bunnyCdnApi.getCdnHostname();
  if (!cdnHostname.ok) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: cdnHostname.error });
    return cdnHostname;
  }
  const target = cdnHostname.hostname;

  // 2. Add CNAME record in DNS zone
  const zoneId = getBunnyDnsZoneId();
  const addResponse = await fetchDrained(
    `${BUNNY_API_BASE}/dnszone/${zoneId}/records`,
    {
      method: "PUT",
      headers: {
        AccessKey: getBunnyApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Type: DNS_RECORD_TYPE_CNAME,
        Name: recordName,
        Value: target,
        Ttl: 300,
      }),
    },
  );

  if (!addResponse.ok) {
    const err = parseBunnyError(addResponse, "Add DNS CNAME record");
    logError({ code: ErrorCode.CDN_REQUEST, detail: err.error });
    return err;
  }

  // 3. Register hostname with pull zone (add hostname + SSL)
  const cdnResult = await bunnyCdnApi.validateCustomDomain(fullDomain);
  if (!cdnResult.ok) return cdnResult;

  return { ok: true, fullDomain };
};

/** Stubbable API for testing */
export const bunnyCdnApi = {
  validateCustomDomain: validateCustomDomainImpl,
  findPullZoneId: findPullZoneIdImpl,
  getDnsZone: getDnsZoneImpl,
  checkSubdomainAvailable: checkSubdomainAvailableImpl,
  registerBunnySubdomain: registerBunnySubdomainImpl,
  getEdgeScript: getEdgeScriptImpl,
  getCdnHostname: getCdnHostnameImpl,
};

/** Validate a custom domain (delegates to bunnyCdnApi for testability). */
export const validateCustomDomain = (
  hostname: string,
): Promise<BunnyApiResult> => bunnyCdnApi.validateCustomDomain(hostname);

/** Check whether a bunny subdomain is available. */
export const checkSubdomainAvailable = (subdomain: string) =>
  bunnyCdnApi.checkSubdomainAvailable(subdomain);

/** Register a bunny subdomain (DNS + CDN). */
export const registerBunnySubdomain = (subdomain: string) =>
  bunnyCdnApi.registerBunnySubdomain(subdomain);

/** Get CDN hostname (delegates to bunnyCdnApi for testability). */
export const getCdnHostname = (): Promise<CdnHostnameResult> =>
  bunnyCdnApi.getCdnHostname();
