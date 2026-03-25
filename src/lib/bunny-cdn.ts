/**
 * Bunny CDN pull zone API integration.
 * Adds a custom hostname to a pull zone and enables force SSL.
 * Only used when BUNNY_API_KEY env var is set.
 * The pull zone ID is discovered automatically by matching hostnames.
 */

import {
  getBunnyApiKey,
  getBunnyDnsSubdomainSuffix,
  getBunnyDnsZoneId,
  getCdnHostname,
  getEffectiveDomain,
} from "#lib/config.ts";
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
 * (effective domain with .bunny.run replaced by .b-cdn.net).
 */
const findPullZoneIdImpl = async (): Promise<
  { ok: true; id: number } | { ok: false; error: string; errorKey?: string }
> => {
  const cdnHostname = getCdnHostname();
  const response = await fetch(
    `${BUNNY_API_BASE}/pullzone?search=${encodeURIComponent(cdnHostname)}`,
    { headers: { AccessKey: getBunnyApiKey() } },
  );

  if (!response.ok) {
    return parseBunnyError(response, "List pull zones");
  }

  const data: BunnyPullZoneListResponse = await response.json();
  const zone = data.Items.find((z) =>
    z.Hostnames.some((h) => h.Value === cdnHostname),
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
  const response = await fetch(`${BUNNY_API_BASE}/dnszone/${zoneId}`, {
    headers: { AccessKey: getBunnyApiKey() },
  });

  if (!response.ok) {
    const result = await parseBunnyError(response, "Get DNS zone");
    return result;
  }

  const zone: BunnyDnsZone = await response.json();
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
  const target = getEffectiveDomain();

  // 2. Add CNAME record in DNS zone
  const zoneId = getBunnyDnsZoneId();
  const addResponse = await fetch(
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
    const err = await parseBunnyError(addResponse, "Add DNS CNAME record");
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
