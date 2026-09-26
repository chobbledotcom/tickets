/**
 * Deno Deploy API client — creates and deploys edge apps on Deno Deploy.
 * Used by the site builder as an alternative hosting provider to Bunny Edge Scripting.
 *
 * API base: https://api.deno.com/v2
 * Auth: Authorization: Bearer {DENO_DEPLOY_TOKEN}
 */

/* jscpd:ignore-start */
import {
  denoDeployAppSlug,
  getDenoDeployOrgId,
  getDenoDeployOrgSlug,
  getDenoDeployToken,
} from "#shared/config.ts";
import {
  DenoAppEnvVarsSchema,
  DenoAppIdentitySchema,
  type DenoEnvVar,
  type DenoRevision,
  DenoRevisionSchema,
} from "#shared/deno-deploy-schema.ts";
import { errorMessage } from "#shared/error-message.ts";
import { fetchText, parseApiError } from "#shared/fetch.ts";
import type {
  HostingProviderApi,
  PrepareSiteFn,
} from "#shared/provider-types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import { parseJson } from "#shared/validation/parse.ts";

/* jscpd:ignore-end */

const DENO_API_BASE = "https://api.deno.com/v2";

/** Headers for all Deno Deploy API requests. */
const denoApiHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getDenoDeployToken()}`,
  "Content-Type": "application/json",
});

const parseDenoRevision = (text: string): DenoRevision =>
  parseJson(DenoRevisionSchema, text);

const getDenoApi = async <T>(
  path: string,
  label: string,
  parse: (text: string) => T,
): Promise<Result<T>> => {
  const res = await fetchText(`${DENO_API_BASE}/${path}`, {
    headers: denoApiHeaders(),
  });
  if (!res.ok) return parseApiError(res, label);
  return okResult(parse(res.text));
};

/**
 * Create a new Deno Deploy app with the given slug.
 * Returns the app ID and final slug.
 */
const createAppImpl = async (
  slug: string,
): Promise<Result<{ appId: string; slug: string }>> => {
  const orgId = getDenoDeployOrgId();
  const res = await fetchText(`${DENO_API_BASE}/apps`, {
    body: JSON.stringify({ orgId, slug }),
    headers: denoApiHeaders(),
    method: "POST",
  });

  if (!res.ok) return parseApiError(res, "Create app");

  const data = parseJson(DenoAppIdentitySchema, res.text);
  return okResult({ appId: data.id, slug: data.slug });
};

/** Fetch the current env vars for a Deno Deploy app, values included for
 * plain entries (secret entries mask their value). */
const getAppEnvVarsImpl = async (
  appId: string,
): Promise<Result<DenoEnvVar[]>> => {
  const result = await getDenoApi(
    `apps/${encodeURIComponent(appId)}`,
    "Get app",
    (text) => parseJson(DenoAppEnvVarsSchema, text),
  );
  return result.ok ? okResult(result.value.env_vars) : result;
};

/** The app's env var keys — the names-only view of {@link getAppEnvVarsImpl}. */
const getAppEnvVarNamesImpl = async (
  appId: string,
): Promise<Result<string[]>> => {
  const result = await getAppEnvVarsImpl(appId);
  return result.ok ? okResult(result.value.map(({ key }) => key)) : result;
};

/** One env var entry as the PATCH body sends it: plain or secret, and the
 * production context unless the caller narrows it. */
export interface DenoEnvVarUpdate {
  contexts?: string[];
  key: string;
  secret?: boolean;
  value: string;
}

/** The default body for one env var entry. */
const denoEnvVarPatch = (entry: DenoEnvVarUpdate) => ({
  contexts: entry.contexts ?? ["production"],
  key: entry.key,
  secret: entry.secret ?? true,
  value: entry.value,
});

/** PATCH env var entries onto a Deno Deploy app. The API deep-merges
 * env_vars by key, so every var the entries do not name stays untouched. */
const patchAppEnvVars = async (
  appId: string,
  entries: DenoEnvVarUpdate[],
  label: string,
) => {
  const patchRes = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}`,
    {
      body: JSON.stringify({
        env_vars: entries.map(denoEnvVarPatch),
      }),
      headers: denoApiHeaders(),
      method: "PATCH",
    },
  );

  if (!patchRes.ok) return parseApiError(patchRes, label);
  return okResult(undefined);
};

/**
 * Set ONE environment variable on a Deno Deploy app, plain or secret.
 */
const setEnvVarImpl = (appId: string, entry: DenoEnvVarUpdate) =>
  patchAppEnvVars(appId, [entry], "Set app env var");

/** Set secret environment variables on a Deno Deploy app, all in production.
 * (Re-sending existing secrets risks clearing them: the GET response masks
 * secret values, so a round-trip GET→merge→PATCH would PATCH with empty
 * values. The supplied pairs always carry their full value.) */
const envVar = ([key, value]: [string, string]): DenoEnvVarUpdate => ({
  contexts: ["production"],
  key,
  secret: true,
  value,
});

const setEnvVarsImpl = (appId: string, secrets: [string, string][]) =>
  patchAppEnvVars(appId, secrets.map(envVar), "Set app env vars");

const REVISION_POLL_BACKOFF_MS = Array<number>(20).fill(1_000);

class RevisionPendingError extends Error {}

const revisionOutcome = (revision: DenoRevision): Result<void> | null => {
  if (revision.status === "succeeded") return okResult(undefined);
  if (revision.status === "queued" || revision.status === "building") {
    return null;
  }
  return errorResult(
    `Deno revision ${revision.id} ${revision.status}: ${
      revision.failure_reason ?? revision.status
    }`,
  );
};

const fetchRevision = async (
  revisionId: string,
): Promise<Result<DenoRevision>> =>
  getDenoApi(
    `revisions/${encodeURIComponent(revisionId)}`,
    "Get revision",
    parseDenoRevision,
  );

const waitForRevision = async (
  initial: DenoRevision,
): Promise<Result<void>> => {
  let current = initial;
  let fetchNext = false;
  try {
    return await retryWithBackoff(
      async () => {
        if (fetchNext) {
          const fetched = await fetchRevision(initial.id);
          if (!fetched.ok) throw new Error(fetched.error);
          current = fetched.value;
        }
        const outcome = revisionOutcome(current);
        if (outcome) return outcome;
        fetchNext = true;
        throw new RevisionPendingError();
      },
      REVISION_POLL_BACKOFF_MS,
      (error, { willRetry }) => {
        if (willRetry) return;
        if (error instanceof RevisionPendingError) {
          throw new Error(
            `Deno revision ${initial.id} did not finish within ${REVISION_POLL_BACKOFF_MS.length} seconds`,
          );
        }
        throw new Error(
          `Deno revision ${initial.id} could not be read: ${errorMessage(error)}`,
          { cause: error },
        );
      },
    );
  } catch (error) {
    return errorResult(errorMessage(error));
  }
};

/**
 * Deploy code to a Deno Deploy app (production deployment).
 * Returns the primary hostname for the deployment.
 */
const deployCodeImpl: HostingProviderApi["publishSite"] = async (
  appId,
  code,
) => {
  const res = await fetchText(
    `${DENO_API_BASE}/apps/${encodeURIComponent(appId)}/deploy`,
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
  return waitForRevision(parseDenoRevision(res.text));
};

/** Stubbable API for testing */
export const denoDeployApi = {
  createApp: createAppImpl,
  deployCode: deployCodeImpl,
  getAppEnvVars: getAppEnvVarsImpl,
  getEnvVarNames: getAppEnvVarNamesImpl,
  setEnvVar: setEnvVarImpl,
  setEnvVars: setEnvVarsImpl,
};

const prepareDenoSiteImpl: PrepareSiteFn = async (name, _code, secrets) => {
  const createResult = await denoDeployApi.createApp(denoDeployAppSlug(name));
  if (!createResult.ok) return createResult;
  const setResult = await denoDeployApi.setEnvVars(
    createResult.value.appId,
    secrets,
  );
  if (!setResult.ok) {
    return errorResult(`Failed to set secrets: ${setResult.error}`);
  }
  return okResult({
    defaultHostname: `https://${createResult.value.slug}.${getDenoDeployOrgSlug()}.deno.net`,
    hostingId: createResult.value.appId,
  });
};

export const denoHostingProvider: HostingProviderApi = {
  configEnvVar: "DENO_DEPLOY_TOKEN",
  getSecretNames: (hostingId) => denoDeployApi.getEnvVarNames(hostingId),
  prepareSite: prepareDenoSiteImpl,
  publishSite: (hostingId, code) => denoDeployApi.deployCode(hostingId, code),
  setSecrets: (hostingId, secrets) =>
    denoDeployApi.setEnvVars(hostingId, secrets),
};
