/** Shared Bunny API plumbing: request helpers, result types, and error
 *  parsing. The resource clients (pull zone, DNS, edge script) all read this
 *  module; it reads none of them. */

import { dryRunOrFetchText } from "#shared/builder-dry-run.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { type FetchResult, fetchText, parseApiError } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

export const BUNNY_API_BASE = "https://api.bunny.net";

/** The error branch shared by every Bunny API result — a failed call with its
 *  message and optional Bunny ErrorKey. */
export type BunnyApiError = {
  ok: false;
  error: string;
  errorKey?: string | undefined;
};

export type BunnyApiResult = { ok: true } | BunnyApiError;

/**
 * GET a Bunny API endpoint with AccessKey auth and parse the JSON body, or
 * surface a Bunny API error. Shared by the edge-script, secrets, and DNS reads.
 */
export const bunnyGetJson = async <T>(
  path: string,
  label: string,
): Promise<{ ok: true; data: T } | BunnyApiError> => {
  const response = await fetchText(`${BUNNY_API_BASE}${path}`, {
    headers: { AccessKey: getBunnyApiKey() },
  });
  if (!response.ok) return parseBunnyError(response, label);
  return { data: JSON.parse(response.text) as T, ok: true };
};

/** Return ok for a successful response or parse an error. */
export const okOrError = (
  response: FetchResult,
  label: string,
): BunnyApiResult =>
  response.ok ? { ok: true } : parseBunnyError(response, label);

/** Extract the Bunny-specific ErrorKey from a raw response body, if present. */
const extractBunnyErrorKey = (text: string): string | undefined => {
  try {
    const json = JSON.parse(text) as { ErrorKey?: string };
    return json.ErrorKey;
  } catch {
    return;
  }
};

/** Parse a Bunny API error response into a BunnyApiResult. */
export const parseBunnyError = (
  response: FetchResult,
  label: string,
): BunnyApiResult & { ok: false } => ({
  ...parseApiError(response, label, ["Message"]),
  errorKey: extractBunnyErrorKey(response.text),
});

/** A Bunny API request that carries only the AccessKey header and no body —
 *  the shared shape of the plain GET/DELETE calls. */
export const bunnyKeyRequest = (
  url: string,
  method: string,
): Promise<FetchResult> =>
  fetchText(url, {
    headers: { AccessKey: getBunnyApiKey() },
    method,
  });

/** A Bunny API request that carries the AccessKey header and a JSON body — the
 * shared shape of every POST/PUT call. `body` is already-serialized JSON. */
export const bunnyJsonRequest = (
  url: string,
  body: string,
  method: string,
): Promise<FetchResult> =>
  dryRunOrFetchText(url, () => ({
    body,
    headers: {
      AccessKey: getBunnyApiKey(),
      "Content-Type": "application/json",
    },
    method,
  }));

/** Report a failed Bunny call and hand the failure straight back — what every
 * step below does when its call does not come back ok. */
export const reported = <T extends { error: string }>(failure: T): T => {
  logError({ code: ErrorCode.CDN_REQUEST, detail: failure.error });
  return failure;
};
