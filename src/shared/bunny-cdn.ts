/** Bunny CDN hosting provider. This module assembles the resource clients
 *  (pull zone, DNS, edge script) behind the stubbable `bunnyCdnApi` seam that
 *  tests stub. It also exposes the hosting provider and entry points. */

import {
  type BunnyApiResult,
  bunnyGetJson,
  bunnyJsonRequest,
  parseBunnyError,
} from "#shared/bunny-api.ts";
import {
  checkSubdomainAvailableImpl,
  type DomainResult,
  deleteDnsRecordImpl,
  getDnsZoneImpl,
  registerBunnySubdomainImpl,
  type SubdomainAvailability,
} from "#shared/bunny-dns.ts";
import {
  createEdgeScriptImpl,
  deployScriptCodeImpl,
  listEdgeScriptSecretsImpl,
  publishEdgeScriptImpl,
  setEdgeScriptSecretImpl,
} from "#shared/bunny-edge-script.ts";
import {
  type CdnHostnameResult,
  findPullZoneIdImpl,
  getCdnHostnameImpl,
  getEdgeScriptImpl,
  updatePullZoneImpl,
  validateCustomDomainImpl,
} from "#shared/bunny-pull-zone.ts";
import { delay } from "#shared/now.ts";
import type { HostingProviderApi } from "#shared/provider-types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

const bunnyVoidResult = (result: BunnyApiResult): Result<void> =>
  result.ok ? okResult(undefined) : errorResult(result.error);

/** Stubbable API for testing. Every cross-client route in the impls below goes
 *  back through this object, so a stub on one method reroutes that step. The
 *  three composed entries carry return types because they reference this very
 *  object in their wiring. */
export const bunnyCdnApi = {
  checkSubdomainAvailable: (
    subdomain: string,
  ): Promise<SubdomainAvailability> =>
    checkSubdomainAvailableImpl({
      getDnsZone: () => bunnyCdnApi.getDnsZone(),
    })(subdomain),
  createEdgeScript: createEdgeScriptImpl,
  delay,
  deleteDnsRecord: deleteDnsRecordImpl,
  deployScriptCode: deployScriptCodeImpl,
  findPullZoneId: findPullZoneIdImpl,
  getCdnHostname: getCdnHostnameImpl,
  getDnsZone: getDnsZoneImpl,
  getEdgeScript: getEdgeScriptImpl,
  listEdgeScriptSecrets: listEdgeScriptSecretsImpl,
  publishEdgeScript: publishEdgeScriptImpl,
  registerBunnySubdomain: (subdomain: string): Promise<DomainResult> =>
    registerBunnySubdomainImpl({
      checkSubdomainAvailable: (checked) =>
        bunnyCdnApi.checkSubdomainAvailable(checked),
      delay: (ms) => bunnyCdnApi.delay(ms),
      deleteDnsRecord: (zoneId, recordId) =>
        bunnyCdnApi.deleteDnsRecord(zoneId, recordId),
      getCdnHostname: () => bunnyCdnApi.getCdnHostname(),
      validateCustomDomain: (hostname) =>
        bunnyCdnApi.validateCustomDomain(hostname),
    })(subdomain),
  setEdgeScriptSecret: setEdgeScriptSecretImpl,
  updatePullZone: updatePullZoneImpl,
  validateCustomDomain: (hostname: string): Promise<BunnyApiResult> =>
    validateCustomDomainImpl({
      findPullZoneId: () => bunnyCdnApi.findPullZoneId(),
    })(hostname),
};

export const bunnyHostingProvider: HostingProviderApi = {
  configEnvVar: "BUNNY_API_KEY",
  async getSecretNames(hostingId) {
    const result = await bunnyCdnApi.listEdgeScriptSecrets(Number(hostingId));
    return result.ok ? okResult(result.secrets.map((s) => s.Name)) : result;
  },
  async prepareSite(name, code, secrets) {
    const createResult = await bunnyCdnApi.createEdgeScript(name, code);
    if (!createResult.ok) return createResult;
    const { scriptId, pullZoneId, defaultHostname } = createResult;
    const pzResult = await bunnyCdnApi.updatePullZone(pullZoneId, {
      DisableCookies: false,
    });
    if (!pzResult.ok) return pzResult;
    const allSecrets: [string, string][] = [
      ...secrets,
      ["BUNNY_SCRIPT_ID", String(scriptId)],
    ];
    for (const [secretName, secretValue] of allSecrets) {
      const r = await bunnyCdnApi.setEdgeScriptSecret(
        scriptId,
        secretName,
        secretValue,
      );
      if (!r.ok)
        return {
          error: `Failed to set secrets: ${r.error}`,
          ok: false as const,
        };
    }
    return okResult({ defaultHostname, hostingId: String(scriptId) });
  },
  async publishSite(hostingId) {
    return bunnyVoidResult(
      await bunnyCdnApi.publishEdgeScript(Number(hostingId)),
    );
  },
  async setSecrets(hostingId, secrets) {
    const scriptId = Number(hostingId);
    if (Number.isNaN(scriptId)) return errorResult("No hostingId");
    for (const [name, value] of secrets) {
      const r = await bunnyCdnApi.setEdgeScriptSecret(scriptId, name, value);
      if (!r.ok) return r;
    }
    return okResult(undefined);
  },
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

/** Upload and publish new script code to a Bunny edge script (defaults to this
 * host's own script when `scriptId` is omitted). */
export const deployScriptCode = async (
  code: string,
  scriptId?: number | string,
): Promise<Result<void>> =>
  bunnyVoidResult(await bunnyCdnApi.deployScriptCode(code, scriptId));

export type { DomainResult };
// Re-exports for the plumbing callers that read the shared request helpers
// through this module's public surface.
export { bunnyGetJson, bunnyJsonRequest, parseBunnyError };
