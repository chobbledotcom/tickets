/**
 * Fetch wrapper that eagerly consumes the response body.
 *
 * Every outbound HTTP call goes through fetchText, which reads
 * the full body into a string before returning.  This makes response
 * resource leaks structurally impossible — there is no ReadableStream
 * left open for the Deno runtime to complain about.
 */

/** A fetch result whose body has already been read to a string. */
export type FetchResult = {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
};

/** Discriminated result type for external API calls. */
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Parse a JSON error response into a structured error.
 * Tries each key in `keys` (default: ["message", "error"]) in order.
 */
export const parseApiError = (
  response: { status: number; text: string },
  label: string,
  keys: string[] = ["message", "error"],
): { ok: false; error: string } => {
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
  return {
    error: `${label} failed (${response.status}): ${message}`,
    ok: false,
  };
};

/** Fetch a URL and eagerly read the response body, preventing resource leaks. */
export const fetchText = async (
  url: string,
  init?: RequestInit,
): Promise<FetchResult> => {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    headers: response.headers,
    ok: response.ok,
    status: response.status,
    text,
  };
};
