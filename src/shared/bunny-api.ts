/** Shared Bunny API client: base URL, AccessKey auth, status check, error
 *  parse, and JSON parse, all through the shared API client factory. The
 *  resource clients (pull zone, DNS, edge script) all read this module. It
 *  reads none of them. */

/* jscpd:ignore-start -- import block */
import type { GenericSchema } from "valibot";
import { defineApiClient } from "#shared/api-client.ts";
import { dryRunOrFetchText } from "#shared/builder-dry-run.ts";
import { getBunnyApiKey } from "#shared/config.ts";
import { type FetchResult, parseApiError } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
/* jscpd:ignore-end */

export const BUNNY_API_BASE = "https://api.bunny.net";

/** The error branch shared by every Bunny API result — a failed call with its
 *  message and optional Bunny ErrorKey. */
export type BunnyApiError = {
  ok: false;
  error: string;
  errorKey?: string | undefined;
};

export type BunnyApiResult = { ok: true } | BunnyApiError;

/** The AccessKey header every Bunny API request carries. */
const bunnyHeaders = (): Record<string, string> => ({
  AccessKey: getBunnyApiKey(),
});

/** The site-build dry-run fetch every Bunny API client uses: inside a build
 * it answers canned bodies, otherwise it delegates to the real fetch. */
export const bunnyDryRunFetch = (
  url: string,
  init: RequestInit,
): Promise<FetchResult> => dryRunOrFetchText(url, () => init);

/** Extract the Bunny-specific ErrorKey from a raw response body, if present. */
const extractBunnyErrorKey = (text: string): string | undefined => {
  try {
    const json = JSON.parse(text) as { ErrorKey?: string };
    return json.ErrorKey;
  } catch {
    return;
  }
};

/** Parse a Bunny API error response into a BunnyApiError. */
export const parseBunnyError = (
  response: FetchResult,
  label: string,
): BunnyApiError => ({
  ...parseApiError(response, label, ["Message"]),
  errorKey: extractBunnyErrorKey(response.text),
});

/** The shared Bunny client: base URL, AccessKey header, and the bunny error
 * shape (message plus ErrorKey) for every request. */
export const bunnyClient = defineApiClient<BunnyApiError>({
  baseUrl: BUNNY_API_BASE,
  fetchImpl: bunnyDryRunFetch,
  headers: bunnyHeaders,
  parseError: parseBunnyError,
  unreadableError: (label) => ({
    error: `${label} returned an invalid response`,
    ok: false,
  }),
});

/** Map a client result to the bunny result shape (which reads the error
 * fields directly, not through a `value` wrapper). */
const bunnyResult = <T>(
  result: { ok: true; value: T } | { ok: false; error: BunnyApiError },
): { ok: true; data: T } | BunnyApiError =>
  result.ok ? { data: result.value, ok: true } : result.error;

/**
 * GET a Bunny API endpoint with AccessKey auth and parse the JSON body, or
 * surface a Bunny API error. Shared by the edge-script, secrets, and DNS reads.
 */
export const bunnyGetJson = async <T>(
  path: string,
  schema: GenericSchema<unknown, T>,
  label: string,
): Promise<{ ok: true; data: T } | BunnyApiError> =>
  bunnyResult(await bunnyClient.request(path, {}, schema, label));

/** Return ok for a successful response or parse an error. */
export const okOrError = (
  response: FetchResult,
  label: string,
): BunnyApiResult =>
  response.ok ? { ok: true } : parseBunnyError(response, label);

/** One Bunny API request with AccessKey auth. A JSON body is sent for the
 * POST/PUT calls. The plain GET/DELETE calls carry none. */
export const bunnyRequest = (
  path: string,
  method: string,
  body?: string,
): Promise<FetchResult> =>
  bunnyClient.raw(
    path,
    body === undefined
      ? { method }
      : { body, headers: { "Content-Type": "application/json" }, method },
  );

/** Report a failed Bunny call and hand the failure straight back — what every
 * step below does when its call does not come back ok. */
export const reported = <T extends { error: string }>(failure: T): T => {
  logError({ code: ErrorCode.CDN_REQUEST, detail: failure.error });
  return failure;
};
