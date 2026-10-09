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
 *  or unsafe. The input arrives once decoded, from the query or the form.
 *  The rule decodes it once more, so an encoded attack shape cannot survive
 *  as plain text. */
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
  // The percent-encoded attack forms (%2F%2F, %5C) decode to these, so the
  // rule decodes once before it checks.
  if (decoded.includes("//") || decoded.includes("\\")) return null;
  if (hasControlCharacter(decoded)) return null;
  if (!decoded.startsWith(ADMIN_PREFIX)) return null;
  const target = new URL(decoded, "http://localhost");
  const path = `${target.pathname}${target.search}`;
  if (!path.startsWith(ADMIN_PREFIX)) return null;
  // A return to the login page loops, and logout after a successful login is
  // nonsense.
  if (
    target.pathname === "/admin/login" ||
    target.pathname === "/admin/logout"
  ) {
    return null;
  }
  return path;
};

/** The return target a page address carries: the `return_url` query value,
 *  or null when it is absent or unsafe. */
export const returnPathFromQuery = (request: Request): string | null =>
  adminReturnPath(new URL(request.url).searchParams.get(RETURN_URL_PARAM));

/** The return target the auth gate hands the login page: the address the
 *  visitor asked for, with its query, or null when it is unsafe. */
export const returnPathFromRequest = (request: Request): string | null => {
  const url = new URL(request.url);
  return adminReturnPath(`${url.pathname}${url.search}`);
};

/** The login page's address. When a safe target exists, the address carries
 *  it, so the login form holds the target through a failed attempt. */
export const adminLoginPageHref = (returnPath: string | null): string =>
  returnPath === null
    ? "/admin"
    : `/admin?${RETURN_URL_PARAM}=${encodeURIComponent(returnPath)}`;
