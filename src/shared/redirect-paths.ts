// effects: pure
/**
 * The addresses a redirect names. A redirect maps a page of this site to a
 * new place. The rules here decide which addresses an operator can save and
 * which key a request is matched by. They answer a short code. The record
 * turns each code into the message a person reads.
 */

import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  hasControlCharacter,
  hasPathEscapeShape,
  isPathUnder,
} from "#shared/url-safety.ts";

/** Why an operator cannot save a "from" address. */
export type RedirectFromError =
  | "has_query"
  | "not_a_path"
  | "reserved"
  | "unsafe";

/** Why an operator cannot save a "to" address. */
export type RedirectToError = "not_http" | "unsafe";

/** The areas that a redirect never serves. A request there is not a missing
 *  public page, so no redirect can apply to it. */
const RESERVED_PREFIXES = ["/admin", "/api"] as const;

/** A base for reading a path as a URL. Only its path is kept. */
const BASE = "http://redirects.invalid";

/** The key that a path is matched by: lower case, with no trailing slash.
 *  The key of the home page is "/". */
const keyOfPath = (path: string): string => {
  const lower = path.toLowerCase();
  const trimmed = lower.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};

/** Whether a request path can get a redirect. A path in a reserved area
 *  cannot, so the lookup does not run for it. */
export const redirectsServe = (requestPath: string): boolean =>
  !RESERVED_PREFIXES.some((prefix) =>
    isPathUnder(keyOfPath(requestPath), prefix),
  );

/** The key of a request path. The same key is made for a saved "from"
 *  address, so the two meet. */
export const redirectKeyOfRequest = (requestPath: string): string =>
  keyOfPath(requestPath);

/** The path of an address: everything before its query or fragment. */
const pathPart = (address: string): string => address.replace(/[?#].*$/s, "");

/** Whether a path holds a shape that leaves the site. An escape that is
 *  percent-encoded counts too, and so does a malformed escape. */
const escapesTheSite = (path: string): boolean => {
  if (hasControlCharacter(path)) return true;
  try {
    return hasPathEscapeShape(decodeURIComponent(path));
  } catch {
    // A malformed escape is never a real page address.
    return true;
  }
};

/** The key of the page that a "from" address names, or the reason the
 *  address cannot be saved. The address is a path of this site, with no query
 *  and no fragment. */
export const checkRedirectFrom = (
  raw: string,
): Result<string, RedirectFromError> => {
  const address = raw.trim();
  if (!address.startsWith("/")) return errorResult("not_a_path");
  if (/[?#]/.test(address)) return errorResult("has_query");
  if (escapesTheSite(address)) return errorResult("unsafe");
  const key = keyOfPath(new URL(address, BASE).pathname);
  return redirectsServe(key) ? okResult(key) : errorResult("reserved");
};

/** The saved form of a "to" address, or the reason it cannot be saved. The
 *  address is a path of this site, or a whole http or https URL. The saved
 *  form is percent-encoded, so it is always a valid `Location` header. */
export const checkRedirectTo = (
  raw: string,
): Result<string, RedirectToError> => {
  const address = raw.trim();
  if (hasControlCharacter(address)) return errorResult("unsafe");
  if (address.startsWith("/")) {
    if (escapesTheSite(pathPart(address))) return errorResult("unsafe");
    const local = new URL(address, BASE);
    return okResult(`${local.pathname}${local.search}${local.hash}`);
  }
  if (!URL.canParse(address)) return errorResult("not_http");
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return errorResult("not_http");
  }
  // A name and password in front of the host disguise where the link goes.
  return url.username === "" && url.password === ""
    ? okResult(url.href)
    : errorResult("unsafe");
};

/** The key of the page that a saved "to" address names, or null when it
 *  names another site. */
export const redirectKeyOfTarget = (target: string): string | null => {
  if (!target.startsWith("/")) return null;
  return keyOfPath(new URL(pathPart(target), BASE).pathname);
};
