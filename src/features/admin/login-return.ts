/**
 * Where login sends the user: back to the admin page she first asked for.
 *
 * A logged-out visit to an admin page carries that page's address to the
 * login flow in a `return_url` value, and a successful login returns there.
 * The value comes from an attacker, so one pure rule decides what passes: an
 * address for this site's admin area, and nothing else. A missing or unsafe
 * value keeps today's dashboard landing.
 */

/** The name of the return target in a page address and in the login form. */
export const RETURN_URL_PARAM = "return_url";

/** The admin prefix a return target must start with and must keep after URL
 *  normalization. A climb like `/admin/..%2F..%2Fpublic` cannot then slip out
 *  of the admin area. */
const ADMIN_PREFIX = "/admin/";

/** A control character (C0 or DEL) in a page address is never a real page.
 *  It is invisible in a Location header, and an attacker can use it to inject
 *  a header. */
const hasControlCharacter = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

/** The safe target a return value names, or null when the value is absent
 *  or unsafe. The check reads the decoded path, so an encoded attack shape
 *  cannot survive there. A query value keeps its encoded characters: the
 *  site's own invite page sends an encoded https URL in a query. The
 *  redirect target comes from the raw text. */
export const adminReturnPath = (
  raw: string | null | undefined,
): string | null => {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A value with a malformed escape is never a real page address, so the
    // documented outcome is the dashboard landing.
    return null;
  }
  // A control character anywhere is never parameter data: it is invisible in
  // a Location header, and an attacker can use it to inject a header.
  if (hasControlCharacter(decoded)) return null;
  if (!decoded.startsWith(ADMIN_PREFIX)) return null;
  // The redirect target comes from the raw text, so the query keeps its
  // encoded delimiters. A value whose decoded shape passes can still name a
  // non-admin path after URL normalization (a double-encoded path). The raw
  // pathname must hold the prefix too.
  const target = new URL(raw, "http://localhost");
  if (!target.pathname.startsWith(ADMIN_PREFIX)) return null;
  const decodedPathname = decodeURIComponent(target.pathname);
  // The path is the part a redirect navigates by, so the attack shapes live
  // here. They are a protocol-relative address, a backslash (browsers read
  // it as a slash), and a climb out of the admin area. The percent-encoded
  // forms (%2F%2F, %5C) decode to these.
  if (
    decodedPathname.includes("//") ||
    decodedPathname.includes("\\") ||
    decodedPathname.split("/").includes("..")
  ) {
    return null;
  }
  // A return to the login page loops, and logout after a successful login
  // is nonsense.
  if (isRefusedLoginPage(decodedPathname)) return null;
  return `${target.pathname}${target.search}`;
};

/** The login and logout paths the login flow refuses to return to. */
const isRefusedLoginPage = (pathname: string): boolean =>
  pathname === "/admin/login" || pathname === "/admin/logout";

/** The return target a page address carries: the `return_url` query value,
 *  or null when it is absent or unsafe. */
export const returnPathFromQuery = (request: Request): string | null =>
  adminReturnPath(new URL(request.url).searchParams.get(RETURN_URL_PARAM));

/** The return target the auth gate hands the login page: the address the
 *  visitor asked for, with its query, or null when it is unsafe. Only a GET
 *  request is navigable after login: a POST-only path answers 404 when the
 *  browser follows the redirect with GET. */
export const returnPathFromRequest = (request: Request): string | null => {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  return adminReturnPath(`${url.pathname}${url.search}`);
};

/** The login page's address. When a safe target exists, the address carries
 *  it, so the login form holds the target through a failed attempt. */
export const adminLoginPageHref = (returnPath: string | null): string =>
  returnPath === null
    ? "/admin"
    : `/admin?${RETURN_URL_PARAM}=${encodeURIComponent(returnPath)}`;
