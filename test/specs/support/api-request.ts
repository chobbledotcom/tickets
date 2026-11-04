/**
 * What the site answers a caller that carries only an API key: no session,
 * no cookie. Every story request another system makes goes through here, so a
 * gate that started demanding a cookie fails one place.
 */

// jscpd:ignore-start
import { handleRequest } from "#routes";
import { requestAsApiKey } from "#test-utils/session.ts";
// jscpd:ignore-end

export const askedAsKey = (
  carrying: string,
  path: string,
  sending: RequestInit = {},
): Promise<Response> => handleRequest(requestAsApiKey(path, carrying, sending));

/** How a story sends a JSON write: its body, the content type, and any
 * headers the caller adds beside them. */
export const jsonWrite = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
