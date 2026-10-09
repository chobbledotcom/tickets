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
 * For example, "mylisting" + ".tickets" gives "mylisting.tickets".
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

/** The write of one CNAME record: the record id the API reports, for the
 *  cleanup when a later step fails. */
type CnameWrite =
  | { ok: true; recordId: number | undefined }
  | { ok: false; error: string; errorKey?: string | undefined };

/** Add the CNAME record to the DNS zone, and log the full request when the
 *  write fails. */
const addCnameRecord = async (
  zoneId: string,
  recordName: string,
  target: string,
): Promise<CnameWrite> => {
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

  // The response is sometimes not JSON. Cleanup then relies on a zone lookup.
  try {
    const parsed = JSON.parse(addResponse.text);
    return { ok: true, recordId: parsed.Id };
  } catch {
    return { ok: true, recordId: undefined };
  }
};

/** Validate the hostname on the pull zone, waiting between tries so the fresh
 *  DNS record can propagate. One first try, then CERT_RETRY_COUNT retries. */
const retryCertificateSetup = async (
  deps: SubdomainRegistrarDeps,
  fullDomain: string,
): Promise<BunnyApiResult> => {
  let cdnResult = await deps.validateCustomDomain(fullDomain);
  for (const attempt of range(0, CERT_RETRY_COUNT)) {
    if (cdnResult.ok) return cdnResult;
    await deps.delay(certRetryDelay(attempt));
    cdnResult = await deps.validateCustomDomain(fullDomain);
  }
  return cdnResult;
};

/** The registration flow: availability, CNAME record, hostname validation
 *  with retries, and cleanup when validation fails. */
const registerSubdomainFlow = async (
  deps: SubdomainRegistrarDeps,
  subdomain: string,
): Promise<DomainResult> => {
  // 1. Check availability
  const availCheck = await deps.checkSubdomainAvailable(subdomain);
  if (!availCheck.ok) return availCheck;
  if (!availCheck.available) {
    return { error: `Subdomain "${subdomain}" is already taken`, ok: false };
  }
  const fullDomain = availCheck.fullDomain;

  // Resolve the stable CDN hostname for the CNAME target, never the raw
  // script host or the custom domain.
  const cdnHostname = await deps.getCdnHostname();
  if (!cdnHostname.ok) {
    return reported(cdnHostname);
  }

  // 2. Add CNAME record in DNS zone
  const zoneId = getBunnyDnsZoneId();
  const record = await addCnameRecord(
    zoneId,
    buildSubdomainRecordName(subdomain),
    cdnHostname.hostname,
  );
  if (!record.ok) return record;

  // 3. Register hostname with pull zone (add hostname + SSL)
  const cdnResult = await retryCertificateSetup(deps, fullDomain);
  if (cdnResult.ok) return { fullDomain, ok: true };

  // Clean up: remove the DNS record we created since certificate setup failed
  if (record.recordId !== undefined) {
    await deps.deleteDnsRecord(zoneId, record.recordId);
  }
  return cdnResult;
};

/**
 * Register a bunny subdomain. Adds a CNAME DNS record that points to the CDN
 * target, then registers the hostname with the CDN pull zone with force SSL.
 * Certificate loading retries to allow DNS propagation after the record lands.
 */
export const registerBunnySubdomainImpl =
  (deps: SubdomainRegistrarDeps) =>
  (subdomain: string): Promise<DomainResult> =>
    registerSubdomainFlow(deps, subdomain);

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
