/**
 * A built site's support message, stored as a Bunny environment *variable*
 * so the host can read the current text back and edit it per site. A secret
 * can never be read back, which is why the message is not one. Deno Deploy
 * hides env-var values from its API, so per-site editing stays Bunny-only.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  BUNNY_API_BASE,
  bunnyGetJson,
  bunnyJsonRequest,
  parseBunnyError,
} from "#shared/bunny-cdn.ts";
import { okResult, type Result } from "#shared/result.ts";
import {
  type SiteHostingAccess,
  siteHostingAccess,
} from "#shared/site-hosting.ts";
import { tryStep } from "#shared/try-step.ts";

/** The env name shared by the host's support text and every site's copy. */
export const SUPPORT_MESSAGE_KEY = "SUPPORT_PAGE_TEXT";

/** Bunny caps an environment variable's value at 4096 characters. */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4096;

/** The readable success-or-failure shape both edit paths return. */
export type SupportMessageResult = Result<string | null>;

/** The script response this module reads: the script's variable list, each
 * entry carrying its own readable value. */
interface ScriptVariablesResponse {
  EdgeScriptVariables:
    | { Name: string | null; DefaultValue: string | null }[]
    | null;
}

/** Read a script's support-message variable. Null when no value is set. */
const readSupportMessageImpl = async (
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
const setSupportMessageImpl = async (
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

/** Stubbable API for testing. */
export const supportMessageApi = {
  readSupportMessage: (hostingId: string) =>
    tryStep("Read support message", () => readSupportMessageImpl(hostingId)),
  setSupportMessage: (hostingId: string, value: string) =>
    tryStep("Set support message", () =>
      setSupportMessageImpl(hostingId, value),
    ),
};

/** Bunny sites reach their support message on the host's Bunny API key;
 * Deno sites cannot store it as a readable variable at all. */
const bunnySiteAccess = (
  site: BuiltSite,
  blocked: string,
): SiteHostingAccess =>
  site.hostingProvider === "bunny"
    ? siteHostingAccess(site, blocked)
    : {
        error: `This site is not hosted on Bunny, so ${blocked}.`,
        ok: false,
      };

/** Read a built site's current support message. Null when no value is set. */
export const loadSiteSupportMessage = (
  site: BuiltSite,
): Promise<SupportMessageResult> => {
  const access = bunnySiteAccess(site, "its support message can't be read");
  return access.ok
    ? supportMessageApi.readSupportMessage(access.hostingId)
    : Promise.resolve(access);
};

/** Set a built site's support message. An empty string clears it. */
export const saveSiteSupportMessage = async (
  site: BuiltSite,
  value: string,
): Promise<SupportMessageResult> => {
  const access = bunnySiteAccess(site, "its support message can't be set");
  return access.ok
    ? supportMessageApi.setSupportMessage(access.hostingId, value)
    : access;
};
