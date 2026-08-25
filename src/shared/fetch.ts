/**
 * Fetch wrapper that eagerly consumes the response body.
 *
 * Every outbound HTTP call goes through fetchText, which reads
 * the full body into a string before returning.  This makes response
 * resource leaks structurally impossible — there is no ReadableStream
 * left open for the Deno runtime to complain about.
 */

import { concatBytes } from "#crypto/utils.ts";
import { extendedBy, mapNotNullish } from "#fp";
import { errorResult, type Result } from "#shared/result.ts";
import { streamChunks } from "#shared/stream-chunks.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";

/** A fetch result whose body has already been read to a string. */
export type FetchResult = {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
};

export class ResponseBodyTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`Response body exceeds ${maximumBytes} bytes`);
  }
}

const responseText = async (
  response: Response,
  maximumBytes?: number,
): Promise<string> => {
  if (maximumBytes === undefined) return await response.text();
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of streamChunks(response.body)) {
      size += chunk.length;
      if (size > maximumBytes) {
        throw new ResponseBodyTooLargeError(maximumBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      await response.body.cancel();
    }
    throw error;
  }
  return new TextDecoder().decode(concatBytes(...chunks));
};

/**
 * Headers for a JSON API request: the given auth header(s) plus a JSON
 * content type. Each API client supplies its own auth scheme (a bearer token,
 * an access key, …); this keeps the JSON content-type in one place.
 */
export const jsonHeaders: (
  auth: Record<string, string>,
) => Record<string, string> = extendedBy({
  "Content-Type": "application/json",
});

/** A non-empty string, or null when the value is anything else. */
const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** One error entry's message: the entry itself when it is a string, or its
 * `message` field. */
const entryMessage = (entry: unknown): string | null =>
  entry !== null && typeof entry === "object" && "message" in entry
    ? nonEmptyString(entry.message)
    : nonEmptyString(entry);

/** The message at one candidate key: the string itself, or the joined
 * messages when the key holds an array of error entries (SendGrid's
 * `errors` shape). */
const keyMessage = (value: unknown): string | null => {
  if (!Array.isArray(value)) return nonEmptyString(value);
  const messages = mapNotNullish(entryMessage)(value);
  return messages.length > 0 ? messages.join("; ") : null;
};

/**
 * Pull the human-readable message out of an API error response body.
 * Tries each key in `keys` (default: ["message", "error"]) in order.
 * Returns the raw text when the body is not JSON or no key matches.
 */
export const apiErrorMessage = (
  text: string,
  keys: string[] = ["message", "error"],
): string => {
  try {
    const json = JSON.parse(text);
    for (const key of keys) {
      const message = keyMessage(json?.[key]);
      if (message !== null) return message;
    }
  } catch {
    /* use raw text */
  }
  return text;
};

/**
 * Parse a JSON error response into a structured error.
 * Tries each key in `keys` (default: ["message", "error"]) in order.
 */
export const parseApiError = (
  response: { status: number; text: string },
  label: string,
  keys?: string[],
): Result<never> & { ok: false } =>
  errorResult(
    `${label} failed (${response.status}): ${apiErrorMessage(response.text, keys)}`,
  );

/** Fetch a URL and eagerly read the response body, preventing resource leaks. */
export const fetchText = async (
  url: string,
  init?: RequestInit,
  maximumResponseBytes?: number,
): Promise<FetchResult> => {
  countExternalSubrequest(`fetch ${new URL(url).origin}`);
  const response = await fetch(url, init);
  const text = await responseText(response, maximumResponseBytes);
  return {
    headers: response.headers,
    ok: response.ok,
    status: response.status,
    text,
  };
};
