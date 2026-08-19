/**
 * Fetch wrapper that eagerly consumes the response body.
 *
 * Every outbound HTTP call goes through fetchText, which reads
 * the full body into a string before returning.  This makes response
 * resource leaks structurally impossible — there is no ReadableStream
 * left open for the Deno runtime to complain about.
 */

import { concatBytes } from "#crypto/utils.ts";
import { extendedBy } from "#fp";
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

/**
 * Parse a JSON error response into a structured error.
 * Tries each key in `keys` (default: ["message", "error"]) in order.
 */
export const parseApiError = (
  response: { status: number; text: string },
  label: string,
  keys: string[] = ["message", "error"],
): Result<never> & { ok: false } => {
  let message = response.text;
  try {
    const json = JSON.parse(response.text);
    for (const key of keys) {
      if (json[key]) {
        message = json[key] as string;
        break;
      }
    }
  } catch {
    /* use raw text */
  }
  return errorResult(`${label} failed (${response.status}): ${message}`);
};

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
