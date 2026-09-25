/**
 * A built site's support message, stored so the host can read the current
 * text back and edit it per site: a Bunny environment variable, or a plain
 * (non-secret) env var on Deno Deploy. A secret can never be read back, and
 * Deno masks secret values, so the message is not a secret on either host.
 * Deno replaces an entry with the same key on save, so a pre-variable secret
 * copy there disappears at the first save too.
 */

import type { BuiltSite, HostingProvider } from "#db/built-sites/types.ts";
import {
  BUNNY_API_BASE,
  bunnyGetJson,
  bunnyJsonRequest,
  parseBunnyError,
} from "#shared/bunny-cdn.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import { okResult, type Result } from "#shared/result.ts";
import { siteHostingAccess } from "#shared/site-hosting.ts";
import { tryStep } from "#shared/try-step.ts";

/** The env name shared by the host's support text and every site's copy. */
export const SUPPORT_MESSAGE_KEY = "SUPPORT_PAGE_TEXT";

/** Bunny caps an environment variable's value at 2 KB, and Deno Deploy allows
 * 16 KB, so the smaller limit covers every site. */
export const SUPPORT_MESSAGE_MAX_BYTES = 2048;

/** Whether `text` is more bytes than a site can store. */
export const supportMessageTooLong = (text: string): boolean =>
  new TextEncoder().encode(text).length > SUPPORT_MESSAGE_MAX_BYTES;

/** The readable success-or-failure shape both edit paths return. */
export type SupportMessageResult = Result<string | null>;

/** The parts of Bunny's script response this module reads: the script's
 * variable list, each entry carrying its own readable value. */
interface ScriptVariablesResponse {
  EdgeScriptVariables:
    | { Name: string | null; DefaultValue: string | null }[]
    | null;
}

/** A Bunny site's support message: the script's variable by that name. */
const readBunnySupportMessage = async (
  hostingId: string,
): Promise<SupportMessageResult> => {
  const result = await bunnyGetJson<ScriptVariablesResponse>(
    `/compute/script/${encodeURIComponent(hostingId)}`,
    "Read support message",
  );
  if (!result.ok) return result;
  const variable = (result.data.EdgeScriptVariables ?? []).find(
    ({ Name }) => Name === SUPPORT_MESSAGE_KEY,
  );
  return okResult(variable === undefined ? null : variable.DefaultValue);
};

/** Set a script's support-message variable, creating it when absent. Bunny
 * requires a name to belong to either a variable or a secret, never both,
 * so a secret set by hand under the same name makes this call fail. */
const writeBunnySupportMessage = async (
  hostingId: string,
  value: string,
): Promise<SupportMessageResult> => {
  const response = await bunnyJsonRequest(
    `${BUNNY_API_BASE}/compute/script/${encodeURIComponent(hostingId)}/variables`,
    JSON.stringify({ DefaultValue: value, Name: SUPPORT_MESSAGE_KEY }),
    "PUT",
  );
  if (!response.ok) {
    return parseBunnyError(response, "Set support message");
  }
  return okResult(value);
};

/** A Deno site's support message: a plain env var's value. Secrets never
 * carry their value in the API's answer, and a missing entry reads null. */
const readDenoSupportMessage = async (
  appId: string,
): Promise<SupportMessageResult> => {
  const result = await denoDeployApi.getAppEnvVars(appId);
  if (!result.ok) return result;
  const entry = result.value.find(({ key }) => key === SUPPORT_MESSAGE_KEY);
  return okResult(entry?.secret ? null : (entry?.value ?? null));
};

/** Set a Deno app's support message as a plain env var. The API deep-merges
 * env_vars by key, so every other var stays untouched. */
const writeDenoSupportMessage = async (
  appId: string,
  value: string,
): Promise<SupportMessageResult> => {
  const result = await denoDeployApi.setEnvVar(appId, {
    key: SUPPORT_MESSAGE_KEY,
    secret: false,
    value,
  });
  return result.ok ? okResult(value) : result;
};

/** Stubbable API for testing. */
export const supportMessageApi = {
  readSupportMessage: (provider: HostingProvider, hostingId: string) =>
    tryStep("Read support message", () =>
      provider === "bunny"
        ? readBunnySupportMessage(hostingId)
        : readDenoSupportMessage(hostingId),
    ),
  setSupportMessage: (
    provider: HostingProvider,
    hostingId: string,
    value: string,
  ) =>
    tryStep("Set support message", () =>
      provider === "bunny"
        ? writeBunnySupportMessage(hostingId, value)
        : writeDenoSupportMessage(hostingId, value),
    ),
};

/** Read a built site's current support message. Null when no value is set. */
export const loadSiteSupportMessage = async (
  site: BuiltSite,
): Promise<SupportMessageResult> => {
  const access = siteHostingAccess(site, "its support message can't be read");
  return access.ok
    ? supportMessageApi.readSupportMessage(
        site.hostingProvider,
        access.hostingId,
      )
    : access;
};

/** Set a built site's support message. An empty string clears it. */
export const saveSiteSupportMessage = async (
  site: BuiltSite,
  value: string,
): Promise<SupportMessageResult> => {
  const access = siteHostingAccess(site, "its support message can't be set");
  return access.ok
    ? supportMessageApi.setSupportMessage(
        site.hostingProvider,
        access.hostingId,
        value,
      )
    : access;
};
