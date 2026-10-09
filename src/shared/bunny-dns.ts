/** Bunny DNS client: zone reads, subdomain availability, CNAME registration
 *  with certificate retry, and record cleanup. */

import { range } from "#fp";
import {
  type BunnyApiResult,
  bunnyGetJson,
  bunnyJsonRequest,
  bunnyKeyRequest,
  okOrError,
  parseBunnyError,
  reported,
} from "#shared/bunny-api.ts";
import type { CdnHostnameResult } from "#shared/bunny-pull-zone.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getBunnyDnsZoneId,
} from "#shared/config.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

interface BunnyDnsRecord {
  Id: number;
  Name: string;
  Type: number;
  Value: string;
}

interface BunnyDnsZone {
  Domain: string;
  Id: number;
  Records: BunnyDnsRecord[];
}

/** Bunny DNS record type for CNAME (0=A, 1=AAAA, 2=CNAME, 3=TXT, 4=MX, 5=Redirect) */
const DNS_RECORD_TYPE_CNAME = 2;

/**
 * Get a DNS zone by ID, returning the zone domain and records.
 */
export type DnsZoneResult =
  | { ok: true; zone: BunnyDnsZone }
  | { ok: false; error: string };

export const getDnsZoneImpl = async (): Promise<DnsZoneResult> => {
  const result = await bunnyGetJson<BunnyDnsZone>(
    `/dnszone/${getBunnyDnsZoneId()}`,
    "Get DNS zone",
  );
  return result.ok ? { ok: true, zone: result.data } : result;
};

/**
 * Build the full subdomain record name (user choice + suffix).
 * e.g. "mylisting" + ".tickets" → "mylisting.tickets"
 */
export const buildSubdomainRecordName = (subdomain: string): string =>
  `${subdomain}${getBunnyDnsSubdomainSuffix()}`;

/** A Bunny domain call that resolves a full domain on success, or gives an
 * error message on failure. */
type DomainFailure = { ok: false; error: string };
export type DomainResult = { ok: true; fullDomain: string } | DomainFailure;

/** A {@link DomainResult} that also says whether the checked subdomain is
 * still free. */
export type SubdomainAvailability =
  | { ok: true; available: boolean; fullDomain: string }
  | DomainFailure;

/** The zone reads checkSubdomainAvailable needs from the API seam. */
export type DnsZoneReader = {
  getDnsZone: () => Promise<DnsZoneResult>;
};

/**
 * Check whether a subdomain is available in the DNS zone.
 * Looks for any existing record with the same name.
 */
export const checkSubdomainAvailableImpl =
  ({ getDnsZone }: DnsZoneReader) =>
  async (subdomain: string): Promise<SubdomainAvailability> => {
    const zoneResult = await getDnsZone();
    if (!zoneResult.ok) return zoneResult;

    const recordName = buildSubdomainRecordName(subdomain);
    const fullDomain = `${recordName}.${zoneResult.zone.Domain}`;
    const taken = zoneResult.zone.Records.some((r) => r.Name === recordName);
    return { available: !taken, fullDomain, ok: true };
  };

/** Maximum number of retries for certificate loading after DNS record creation. */
const CERT_RETRY_COUNT = 4;

/** Delay in ms between certificate loading retries (5s, 10s, 15s, 20s). */
const certRetryDelay = (attempt: number): number => (attempt + 1) * 5000;

/** The cross-resource collaborators registerBunnySubdomain routes through the
 * API seam: availability check, CDN target, hostname validation, cleanup, and
 * the retry delay. */
export type SubdomainRegistrarDeps = {
  checkSubdomainAvailable: (
    subdomain: string,
  ) => Promise<SubdomainAvailability>;
  getCdnHostname: () => Promise<CdnHostnameResult>;
  validateCustomDomain: (hostname: string) => Promise<BunnyApiResult>;
  deleteDnsRecord: (
    zoneId: string,
    recordId: number,
  ) => Promise<BunnyApiResult>;
  delay: (ms: number) => Promise<void>;
};

/**
 * Register a bunny subdomain: add a CNAME DNS record pointing to the CDN
 * target, then register the hostname with the CDN pull zone (SSL + force SSL).
 * Retries certificate loading to allow DNS propagation after record creation.
 */
export const registerBunnySubdomainImpl =
  (deps: SubdomainRegistrarDeps) =>
  async (subdomain: string): Promise<DomainResult> => {
    // 1. Check availability
    const availCheck = await deps.checkSubdomainAvailable(subdomain);
    if (!availCheck.ok) return availCheck;
    if (!availCheck.available) {
      return { error: `Subdomain "${subdomain}" is already taken`, ok: false };
    }

    const recordName = buildSubdomainRecordName(subdomain);
    const fullDomain = availCheck.fullDomain;

    // Resolve the stable CDN hostname for the CNAME target, never the raw
    // script host or the custom domain.
    const cdnHostname = await deps.getCdnHostname();
    if (!cdnHostname.ok) {
      return reported(cdnHostname);
    }
    const target = cdnHostname.hostname;

    // 2. Add CNAME record in DNS zone
    const zoneId = getBunnyDnsZoneId();
    const dnsRecordBody = {
      Name: recordName,
      Ttl: 300,
      Type: DNS_RECORD_TYPE_CNAME,
      Value: target,
    };
    const dnsUrl = `https://api.bunny.net/dnszone/${zoneId}/records`;
    const addResponse = await bunnyJsonRequest(
      dnsUrl,
      JSON.stringify(dnsRecordBody),
      "PUT",
    );

    if (!addResponse.ok) {
      const err = parseBunnyError(addResponse, "Add DNS CNAME record");
      logError({
        code: ErrorCode.CDN_REQUEST,
        detail: `${err.error} | url=${dnsUrl} body=${JSON.stringify(
          dnsRecordBody,
        )}`,
      });
      return err;
    }

    // Extract record ID from response for cleanup on failure
    let dnsRecordId: number | undefined;
    try {
      const parsed = JSON.parse(addResponse.text);
      if (parsed.Id) dnsRecordId = parsed.Id;
    } catch {
      /* response may not be JSON; cleanup will rely on zone lookup */
    }

    // 3. Register hostname with pull zone (add hostname + SSL)
    //    Retry to allow DNS propagation after CNAME record creation.
    let cdnResult = await deps.validateCustomDomain(fullDomain);
    for (const attempt of range(0, CERT_RETRY_COUNT)) {
      if (cdnResult.ok) break;
      await deps.delay(certRetryDelay(attempt));
      cdnResult = await deps.validateCustomDomain(fullDomain);
    }

    if (!cdnResult.ok) {
      // Clean up: remove the DNS record we created since certificate setup failed
      if (dnsRecordId !== undefined) {
        await deps.deleteDnsRecord(zoneId, dnsRecordId);
      }
      return cdnResult;
    }

    return { fullDomain, ok: true };
  };

/**
 * Delete a DNS record by ID. Used to clean up CNAME records when
 * certificate provisioning fails after DNS record creation.
 */
export const deleteDnsRecordImpl = async (
  zoneId: string,
  recordId: number,
): Promise<BunnyApiResult> => {
  const url = `https://api.bunny.net/dnszone/${zoneId}/records/${recordId}`;
  const response = await bunnyKeyRequest(url, "DELETE");
  return okOrError(response, "Delete DNS record");
};
