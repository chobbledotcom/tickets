/** Bunny edge script (compute script) client: create, publish, set and list
 *  secrets, and deploy new code. Shared by the site builder and self-update. */

import {
  type BunnyApiError,
  type BunnyApiResult,
  bunnyGetJson,
  bunnyJsonRequest,
  okOrError,
  parseBunnyError,
} from "#shared/bunny-api.ts";
import { getBunnyScriptId } from "#shared/config.ts";
import type { FetchResult } from "#shared/fetch.ts";

/** POST/PUT to a compute script endpoint with JSON body and AccessKey auth. */
const computeScriptRequest = (
  path: string,
  method: string,
  body: string,
): Promise<FetchResult> =>
  bunnyJsonRequest(`https://api.bunny.net${path}`, body, method);

/** POST/PUT to /compute/script/{id}/{action} */
const scriptAction = (
  scriptId: number | string,
  action: string,
  method: string,
  body: string,
): Promise<FetchResult> =>
  computeScriptRequest(
    `/compute/script/${encodeURIComponent(scriptId)}/${action}`,
    method,
    body,
  );

/** Publish a Bunny edge script by ID. */
const publishScript = async (
  scriptId: number | string,
  label: string,
): Promise<BunnyApiResult> =>
  okOrError(await scriptAction(scriptId, "publish", "POST", "{}"), label);

interface CreateEdgeScriptResult {
  defaultHostname: string;
  ok: true;
  pullZoneId: number;
  scriptId: number;
}

/**
 * Create a new Bunny edge script with the given name and code.
 * ScriptType 2 = standalone (no linked pull zone auto-created by default).
 * CreateLinkedPullZone = true to get a default hostname.
 */
export const createEdgeScriptImpl = async (
  name: string,
  code: string,
): Promise<CreateEdgeScriptResult | { ok: false; error: string }> => {
  const response = await computeScriptRequest(
    "/compute/script",
    "POST",
    JSON.stringify({
      Code: code,
      CreateLinkedPullZone: true,
      Name: name,
      ScriptType: 1,
    }),
  );

  if (!response.ok) {
    return parseBunnyError(response, "Create edge script");
  }

  const data = JSON.parse(response.text);
  return {
    defaultHostname: data.DefaultHostname ?? "",
    ok: true,
    pullZoneId: data.LinkedPullZones[0].Id,
    scriptId: data.Id,
  };
};

/** Set a secret on a Bunny edge script. */
export const setEdgeScriptSecretImpl = async (
  scriptId: number,
  name: string,
  value: string,
): Promise<BunnyApiResult> =>
  okOrError(
    await scriptAction(
      scriptId,
      "secrets",
      "PUT",
      JSON.stringify({ Name: name, Secret: value }),
    ),
    `Set secret ${name}`,
  );

/** A secret as reported by the Bunny API (name + metadata only — never the value). */
export interface EdgeScriptSecret {
  Id: number;
  LastModified: string;
  Name: string;
}

interface ListEdgeScriptSecretsResponse {
  Secrets: EdgeScriptSecret[] | null;
}

type ListSecretsResult =
  | { ok: true; secrets: EdgeScriptSecret[] }
  | BunnyApiError;

/**
 * List the secrets currently set on a Bunny edge script. The API returns each
 * secret's name and metadata only — values are never exposed.
 */
export const listEdgeScriptSecretsImpl = async (
  scriptId: number | string,
): Promise<ListSecretsResult> => {
  const result = await bunnyGetJson<ListEdgeScriptSecretsResponse>(
    `/compute/script/${encodeURIComponent(scriptId)}/secrets`,
    "List secrets",
  );
  if (!result.ok) return result;
  return { ok: true, secrets: result.data.Secrets ?? [] };
};

/**
 * Publish a Bunny edge script.
 */
export const publishEdgeScriptImpl = (
  scriptId: number,
): Promise<BunnyApiResult> => publishScript(scriptId, "Publish edge script");

/**
 * Upload new code to a Bunny edge script and publish it. Without `scriptId`
 * this updates the host's own script. Pass `scriptId` to deploy the same
 * release to another edge script, for example a built site.
 */
export const deployScriptCodeImpl = async (
  code: string,
  scriptId: number | string = getBunnyScriptId(),
): Promise<BunnyApiResult> => {
  const upload = await scriptAction(
    scriptId,
    "code",
    "POST",
    JSON.stringify({ Code: code }),
  );
  if (!upload.ok) {
    return okOrError(upload, "Upload script code");
  }

  return publishScript(scriptId, "Publish script");
};
