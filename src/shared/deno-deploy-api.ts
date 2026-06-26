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
 * Set (or merge) environment variables on a Deno Deploy app.
 * GETs the existing env vars first, merges in the new ones, then PATCHes —
 * so existing variables not in `secrets` are preserved.
 */
const setEnvVarsImpl = async (
  appId: string,
  secrets: [string, string][],
): Promise<ApiResult<Record<never, never>>> => {
  // 1. Fetch existing env vars so we don't overwrite unrelated ones
  const appResult = await fetchAppEnvVars(appId);
  if (!appResult.ok) return appResult;
  const existing = appResult.envVars;

  // 2. Merge: new secrets override any existing key with the same name
  const merged = { ...existing };
  for (const [key, value] of secrets) {
    merged[key] = { is_secret: true, value };
  }

  const envVarsArray = Object.entries(merged).map(([key, entry]) => ({
    contexts: ["production"],
    key,
    secret: entry.is_secret,
    value: entry.value,
  }));

  // 3. PATCH the app with the merged set
  const patchRes = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}`,
    {
      body: JSON.stringify({ env_vars: envVarsArray }),
      headers: denoApiHeaders(),
      method: "PATCH",
    },
  );

  if (!patchRes.ok) return parseApiError(patchRes, "Set app env vars");
  return { ok: true };
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
