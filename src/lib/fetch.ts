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

/** Fetch a URL and eagerly read the response body, preventing resource leaks. */
export const fetchText = async (
  url: string,
  init?: RequestInit,
): Promise<FetchResult> => {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    text,
    headers: response.headers,
  };
};
