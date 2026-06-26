/**
 * Deno Deploy API client — creates and deploys edge apps on Deno Deploy.
 * Used by the site builder as an alternative hosting provider to Bunny Edge Scripting.
 *
 * API base: https://api.deno.com/v2
 * Auth: Authorization: Bearer {DENO_DEPLOY_TOKEN}
 */

import {
  getDenoDeployOrgId,
  getDenoDeployToken,
  slugifyForProvider,
} from "#shared/config.ts";
import { type ApiResult, fetchText, parseApiError } from "#shared/fetch.ts";
import type { HostingProviderApi } from "#shared/provider-types.ts";

const DENO_API_BASE = "https://api.deno.com/v2";

interface CreateAppResponse {
  id: string;
  slug: string;
}

interface GetAppResponse {
  id: string;
  slug: string;
  env_vars?: Record<string, { value: string; is_secret: boolean }>;
}

interface DeploymentResponse {
  id: string;
  domains?: string[];
  hostnames?: string[];
}

/** Headers for all Deno Deploy API requests. */
const denoApiHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getDenoDeployToken()}`,
  "Content-Type": "application/json",
});

/**
 * Sanitize a site name into a valid Deno Deploy slug.
 * Rules: 3–32 chars, lowercase letters/numbers/hyphens, no leading/trailing hyphens.
 */
export const slugifyForDeno = (name: string): string => {
  const slug = slugifyForProvider(name, 32);
  if (slug.length >= 3) return slug;
  return `${slug}app`.slice(0, 32);
};

/**
 * Create a new Deno Deploy app with the given slug.
 * Returns the app ID and final slug.
 */
const createAppImpl = async (
  slug: string,
): Promise<ApiResult<{ appId: string; slug: string }>> => {
  const orgId = getDenoDeployOrgId();
  const res = await fetchText(`${DENO_API_BASE}/apps`, {
    body: JSON.stringify({ orgId, slug }),
    headers: denoApiHeaders(),
    method: "POST",
  });

  if (!res.ok) return parseApiError(res, "Create app");

  const data: CreateAppResponse = JSON.parse(res.text);
  return { appId: data.id, ok: true, slug: data.slug };
};

/** Fetch the current env vars for a Deno Deploy app. */
const fetchAppEnvVars = async (
  appId: string,
): Promise<
  | { ok: true; envVars: Record<string, { value: string; is_secret: boolean }> }
  | { ok: false; error: string }
> => {
  const res = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}`,
    { headers: denoApiHeaders() },
  );
  if (!res.ok) return parseApiError(res, "Get app");
  const data: GetAppResponse = JSON.parse(res.text);
  return { envVars: data.env_vars ?? {}, ok: true };
};

/**
 * Set environment variables on a Deno Deploy app.
 * PATCHes only the supplied secrets — the Deno API deep-merges by key, so
 * existing vars not in `secrets` are preserved without re-sending them.
 * (Re-sending existing secrets risks clearing them: the GET response masks
 * secret values, so a round-trip GET→merge→PATCH would PATCH with empty values.)
 */
const setEnvVarsImpl = async (appId: string, secrets: [string, string][]) => {
  const envVarsArray = secrets.map(([key, value]) => ({
    contexts: ["production"],
    key,
    secret: true,
    value,
  }));

  const patchRes = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}`,
    {
      body: JSON.stringify({ env_vars: envVarsArray }),
      headers: denoApiHeaders(),
      method: "PATCH",
    },
  );

  if (!patchRes.ok) return parseApiError(patchRes, "Set app env vars");
  return { ok: true as const };
};

/**
 * Deploy code to a Deno Deploy app (production deployment).
 * Returns the primary hostname for the deployment.
 */
const deployCodeImpl = async (
  appId: string,
  code: string,
): Promise<ApiResult<{ hostname: string }>> => {
  const res = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}/deployments`,
    {
      body: JSON.stringify({
        assets: {
          "main.ts": { content: code, encoding: "utf-8", kind: "file" },
        },
        config: { runtime: { entrypoint: "main.ts", type: "dynamic" } },
        production: true,
      }),
      headers: denoApiHeaders(),
      method: "POST",
    },
  );

  if (!res.ok) return parseApiError(res, "Deploy code");

  const data: DeploymentResponse = JSON.parse(res.text);
  const hostname = data.domains?.[0] ?? data.hostnames?.[0];
  if (!hostname) {
    return { error: "Deploy code failed: no hostname in response", ok: false };
  }
  return { hostname: `https://${hostname}`, ok: true };
};

/**
 * Get the names of environment variables currently set on a Deno Deploy app.
 * Used by the secrets backfill UI to diff against the expected set.
 */
const getEnvVarNamesImpl = async (
  appId: string,
): Promise<ApiResult<{ names: string[] }>> => {
  const appResult = await fetchAppEnvVars(appId);
  if (!appResult.ok) return appResult;
  return { names: Object.keys(appResult.envVars), ok: true };
};

/** Stubbable API for testing */
export const denoDeployApi = {
  createApp: createAppImpl,
  deployCode: deployCodeImpl,
  getEnvVarNames: getEnvVarNamesImpl,
  setEnvVars: setEnvVarsImpl,
};

const createDenoSiteImpl = async (
  name: string,
  code: string,
  secrets: [string, string][],
) => {
  const createResult = await denoDeployApi.createApp(slugifyForDeno(name));
  if (!createResult.ok) return createResult;
  const setResult = await denoDeployApi.setEnvVars(createResult.appId, secrets);
  if (!setResult.ok) {
    return {
      error: `Failed to set secrets: ${setResult.error}`,
      ok: false as const,
    };
  }
  const deployResult = await denoDeployApi.deployCode(createResult.appId, code);
  if (!deployResult.ok) return deployResult;
  return {
    defaultHostname: deployResult.hostname,
    hostingId: createResult.appId,
    ok: true as const,
  };
};

export const denoHostingProvider: HostingProviderApi = {
  configEnvVar: "DENO_DEPLOY_TOKEN",
  createSite: createDenoSiteImpl,
  getSecretNames: (hostingId) => denoDeployApi.getEnvVarNames(hostingId),
  setSecrets: (hostingId, secrets) =>
    denoDeployApi.setEnvVars(hostingId, secrets),
};
