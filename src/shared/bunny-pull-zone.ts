/** Bunny pull-zone client: reads the edge script's linked pull zone, and adds
 *  or updates hostnames on the pull zone. */

import {
  type BunnyApiError,
  type BunnyApiResult,
  bunnyGetJson,
  bunnyJsonRequest,
  bunnyKeyRequest,
  okOrError,
  reported,
} from "#shared/bunny-api.ts";
import { getBunnyScriptId } from "#shared/config.ts";
import { toStableHostname } from "#shared/site-address.ts";

const HOSTNAME_ALREADY_REGISTERED = "pullzone.hostname_already_registered";

interface EdgeScriptLinkedPullZone {
  Id: number;
}

interface EdgeScriptResponse {
  DefaultHostname: string;
  LinkedPullZones: EdgeScriptLinkedPullZone[];
}

export type CdnHostnameResult = { ok: true; hostname: string } | BunnyApiError;

/** The edge script read result: the response data, or the API error. */
export type EdgeScriptResult =
  | { ok: true; data: EdgeScriptResponse }
  | BunnyApiError;

/** The edge-script read the derived lookups accept, so callers route it
 *  through the API seam: a replaced bunnyCdnApi.getEdgeScript is the one
 *  these lookups use. */
export type EdgeScriptLookup = {
  getEdgeScript: () => Promise<EdgeScriptResult>;
};

/**
 * Fetch the edge script details from the Bunny API using BUNNY_SCRIPT_ID.
 * Returns the DefaultHostname and LinkedPullZones.
 */
export const getEdgeScriptImpl = (): Promise<
  { ok: true; data: EdgeScriptResponse } | BunnyApiError
> =>
  bunnyGetJson<EdgeScriptResponse>(
    `/compute/script/${encodeURIComponent(getBunnyScriptId())}`,
    "Get edge script",
  );

/** Map the edge script's data, or pass the API error through. */
const withEdgeScript = async <T>(
  getEdgeScript: EdgeScriptLookup["getEdgeScript"],
  map: (data: EdgeScriptResponse) => T,
): Promise<T | BunnyApiError> => {
  const result = await getEdgeScript();
  if (!result.ok) return result;
  return map(result.data);
};

/**
 * Find the pull zone ID via the edge script's linked pull zones.
 */
export const findPullZoneIdImpl =
  ({ getEdgeScript }: EdgeScriptLookup) =>
  (): Promise<{ ok: true; id: number } | BunnyApiError> =>
    withEdgeScript(getEdgeScript, (data) => {
      const zone = data.LinkedPullZones[0];
      if (!zone) {
        return {
          error: `Edge script ${getBunnyScriptId()} has no linked pull zones`,
          ok: false,
        };
      }
      return { id: zone.Id, ok: true };
    });

/**
 * Get the CDN hostname (DefaultHostname) from the edge script.
 * This is the stable hostname for CNAME targets, independent of request URL.
 */
const toCnameTarget = (hostname: string): string =>
  toStableHostname(hostname.replace(/^https?:\/\//, ""));

export const getCdnHostnameImpl =
  ({ getEdgeScript }: EdgeScriptLookup) =>
  (): Promise<CdnHostnameResult> =>
    withEdgeScript(getEdgeScript, (data) => ({
      hostname: toCnameTarget(data.DefaultHostname),
      ok: true,
    }));

/** POST to a Bunny CDN pull zone endpoint with JSON body. */
const pullZonePost = async (
  pullZoneId: number,
  action: string | undefined,
  body: Record<string, unknown>,
  label: string,
): Promise<BunnyApiResult> => {
  const suffix = action ? `/${action}` : "";
  const url = `https://api.bunny.net/pullzone/${pullZoneId}${suffix}`;

  const response = await bunnyJsonRequest(url, JSON.stringify(body), "POST");
  return okOrError(response, label);
};

/** Request a free ACME certificate for a hostname on a pull zone. */
const loadFreeCertificate = async (
  hostname: string,
): Promise<BunnyApiResult> => {
  const url = `https://api.bunny.net/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(
    hostname,
  )}`;

  const response = await bunnyKeyRequest(url, "GET");

  return okOrError(response, "Load free certificate");
};

/** The reads validateCustomDomain needs from the API seam. */
export type PullZoneLookup = {
  findPullZoneId: () => Promise<{ ok: true; id: number } | BunnyApiError>;
};

/**
 * Validate a custom domain by adding it to the Bunny CDN pull zone
 * and enabling force SSL. Returns success or an error message.
 */
export const validateCustomDomainImpl =
  ({ findPullZoneId }: PullZoneLookup) =>
  async (hostname: string): Promise<BunnyApiResult> => {
    const zoneResult = await findPullZoneId();
    if (!zoneResult.ok) {
      return reported(zoneResult);
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
      return reported(hostnameResult);
    }

    const certResult = await loadFreeCertificate(hostname);
    if (!certResult.ok) {
      return reported(certResult);
    }

    const sslResult = await pullZonePost(
      pullZoneId,
      "setForceSSL",
      { ForceSSL: true, Hostname: hostname },
      "Set force SSL",
    );
    if (!sslResult.ok) {
      return reported(sslResult);
    }

    return { ok: true };
  };

/**
 * Update pull zone settings by ID.
 * Uses POST to /pullzone/{id} with a partial settings payload.
 */
export const updatePullZoneImpl = (
  pullZoneId: number,
  settings: Record<string, unknown>,
): Promise<BunnyApiResult> =>
  pullZonePost(pullZoneId, undefined, settings, "Update pull zone");
