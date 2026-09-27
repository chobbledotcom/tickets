/**
 * A built site's support message, stored so the host can read the current
 * text back and edit it per site: a Bunny environment variable, or a plain
 * (non-secret) env var on Deno Deploy. A secret can never be read back, and
 * Deno masks secret values, so the message is not a secret on either host.
 * Deno replaces an entry with the same key on save, so a pre-variable secret
 * copy there disappears at the first save too.
 */

import * as v from "valibot";
import type { BuiltSite, HostingProvider } from "#db/built-sites/types.ts";
import {
  BUNNY_API_BASE,
  bunnyGetJson,
  bunnyJsonRequest,
  parseBunnyError,
} from "#shared/bunny-cdn.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import type { DenoEnvVar } from "#shared/deno-deploy-schema.ts";
import { okResult, type Result } from "#shared/result.ts";
import { siteHostingAccess } from "#shared/site-hosting.ts";
import { tryStep } from "#shared/try-step.ts";

/** The env name a site's own support message lives under. Every writer of
 * this key goes through a provider API (the Support-message tab, a fresh
 * build's seed), so the value holds real line breaks and no read ever
 * unescapes it — the hand-set SUPPORT_PAGE_TEXT convention is a different
 * channel, read by #shared/support.ts with its legacy unescaping. */
export const SUPPORT_MESSAGE_KEY = "SUPPORT_PAGE_MARKDOWN";

/** Bunny caps an environment variable's value at 2 KB, and Deno Deploy allows
 * 16 KB, so the smaller limit covers every site. */
const SUPPORT_MESSAGE_MAX_BYTES = 2048;
/** Whether `text` is more bytes than a site can store. */
export const supportMessageTooLong = (text: string): boolean =>
  new TextEncoder().encode(text).length > SUPPORT_MESSAGE_MAX_BYTES;

/** The readable success-or-failure shape both edit paths return. */
export type SupportMessageResult = Result<string | null>;

/** The parts of Bunny's script response this module reads: the script's
 * variable list, each entry carrying its own readable value. The key must be
 * present — only Bunny's documented explicit null counts as "no variables",
 * and a response without the key is a contract failure, not an empty list.
 * Bunny's model marks every entry property optional, so an entry may carry no
 * DefaultValue: absence reads as no value, not as a malformed response. */
const ScriptVariablesResponseSchema = v.object({
  EdgeScriptVariables: v.union([
    v.array(
      v.object({
        DefaultValue: v.nullish(v.string()),
        Name: v.nullish(v.string()),
      }),
    ),
    v.null(),
  ]),
});

/** A Bunny site's support message: the script's variable by that name. A
 * malformed success response throws here and the read step reports it. */
const readBunnySupportMessage = async (
  hostingId: string,
): Promise<SupportMessageResult> => {
  const result = await bunnyGetJson<unknown>(
    `/compute/script/${encodeURIComponent(hostingId)}`,
    "Read support message",
  );
  if (!result.ok) return result;
  const variables = v.parse(
    ScriptVariablesResponseSchema,
    result.data,
  ).EdgeScriptVariables;
  const variable = variables?.find(({ Name }) => Name === SUPPORT_MESSAGE_KEY);
  // Bunny's model allows an entry without a DefaultValue: that is no value,
  // the same state as an explicit null.
  return okResult(variable?.DefaultValue ?? null);
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

/** The app's entry for the Support tab's key that the production isolate
 * serves: the all-contexts record, or a production one. The documented
 * contexts can hold the same key in other scopes (a preview record beside a
 * production one), and those are not the serving copy. */
const denoSupportEntry = async (
  appId: string,
): Promise<Result<DenoEnvVar | null>> => {
  const result = await denoDeployApi.getAppEnvVars(appId);
  if (!result.ok) return result;
  const entry =
    result.value.find(
      ({ contexts, key }) =>
        key === SUPPORT_MESSAGE_KEY &&
        (contexts === "all" || contexts.includes("production")),
    ) ?? null;
  return okResult(entry);
};

/** A Deno site's support message: a plain env var's value. Secrets never
 * carry their value in the API's answer, and a missing entry reads null. */
const supportValue = (entry: DenoEnvVar | null): string | null =>
  entry === null || entry.secret ? null : entry.value;

const readDenoSupportMessage = (appId: string): Promise<SupportMessageResult> =>
  denoSupportEntry(appId).then((existing) =>
    existing.ok ? okResult(supportValue(existing.value)) : existing,
  );

/** Set a Deno app's support message as a plain env var. An existing record
 * is updated through its id with its own contexts, so a dashboard-created
 * all-contexts record is edited in place instead of shadowed by a second
 * production entry the tab would never read again. */
const writeDenoSupportMessage = async (
  appId: string,
  value: string,
): Promise<SupportMessageResult> => {
  const existing = await denoSupportEntry(appId);
  if (!existing.ok) return existing;
  const found = existing.value;
  const result = await denoDeployApi.setEnvVar(
    appId,
    found === null
      ? { key: SUPPORT_MESSAGE_KEY, secret: false, value }
      : {
          contexts: found.contexts,
          id: found.id,
          key: SUPPORT_MESSAGE_KEY,
          secret: false,
          value,
        },
  );
  return result.ok ? okResult(value) : result;
};

/** Reading a support message, keyed by hosting provider. A new provider in
 * `HostingProvider` fails to compile until its read is added here. */
const SUPPORT_READERS: Record<
  HostingProvider,
  (hostingId: string) => Promise<SupportMessageResult>
> = {
  bunny: readBunnySupportMessage,
  deno: readDenoSupportMessage,
};

/** Writing a support message, keyed by hosting provider. */
const SUPPORT_WRITERS: Record<
  HostingProvider,
  (hostingId: string, value: string) => Promise<SupportMessageResult>
> = {
  bunny: writeBunnySupportMessage,
  deno: writeDenoSupportMessage,
};

/** Stubbable API for testing. */
export const supportMessageApi = {
  readSupportMessage: (provider: HostingProvider, hostingId: string) =>
    tryStep("Read support message", () => SUPPORT_READERS[provider](hostingId)),
  setSupportMessage: (
    provider: HostingProvider,
    hostingId: string,
    value: string,
  ) =>
    tryStep("Set support message", () =>
      SUPPORT_WRITERS[provider](hostingId, value),
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
