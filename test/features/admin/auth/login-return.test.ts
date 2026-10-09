import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminLoginPageHref,
  adminReturnPath,
  RETURN_URL_PARAM,
  returnPathFromQuery,
  returnPathFromRequest,
} from "#routes/admin/login-return.ts";

/** The values a return target can take. Each accepted row names the exact
 *  path the login flow can send the user to. */
const ACCEPTED: readonly (readonly [string, string])[] = [
  ["/admin/listings/12", "/admin/listings/12"],
  ["/admin/listings/12?tab=notes", "/admin/listings/12?tab=notes"],
  ["/admin/settings/", "/admin/settings/"],
  ["/admin/", "/admin/"],
  ["/admin/café", "/admin/caf%C3%A9"],
  ["%2Fadmin%2Flistings", "/admin/listings"],
];

/** The attack shapes and other values the rule must refuse: addresses for
 *  another site (direct, protocol-relative, percent-encoded), backslashes,
 *  control characters, climbs out of the admin area, the login and logout
 *  pages themselves, and anything that is not an admin path. */
const REFUSED: readonly string[] = [
  "//evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "https://evil.com/admin",
  "http://evil.com/admin/listings/12",
  "javascript:alert(1)",
  "%2F%2Fevil.com",
  "%5Cevil.com",
  "/admin%2F%2Fevil.com",
  "/admin%5Cevil.com",
  "%0A/admin/listings/12",
  "/admin/listings/12\n",
  "/admin/..%2F..%2Fpublic",
  "/admin/../../public",
  "/admin/login",
  "/admin/login?next=/admin/listings",
  "/admin/logout",
  "admin/listings/12",
  "/admin",
  "/public/book",
  " /admin/listings/12",
  "/admin/listings/12?share=https://x.example",
];

describe("the admin login return target", () => {
  test("keeps a safe admin path, with its query", () => {
    for (const [input, expected] of ACCEPTED) {
      expect(adminReturnPath(input), input).toBe(expected);
    }
  });

  test("refuses every attack shape and off-admin value", () => {
    for (const input of REFUSED) {
      expect(adminReturnPath(input), input).toBeNull();
    }
  });

  test("refuses a missing target", () => {
    expect(adminReturnPath(null)).toBeNull();
    expect(adminReturnPath(undefined)).toBeNull();
    expect(adminReturnPath("")).toBeNull();
  });

  test("reads the target from the login page's address", () => {
    const carried = new Request(
      `http://localhost/admin?${RETURN_URL_PARAM}=${encodeURIComponent(
        "/admin/listings/12?tab=notes",
      )}`,
    );
    expect(returnPathFromQuery(carried)).toBe("/admin/listings/12?tab=notes");
    expect(returnPathFromQuery(new Request("http://localhost/admin"))).toBe(
      null,
    );
    expect(
      returnPathFromQuery(
        new Request(`http://localhost/admin?${RETURN_URL_PARAM}=//evil.com`),
      ),
    ).toBe(null);
  });

  test("reads the target the auth gate hands over, with its query", () => {
    expect(
      returnPathFromRequest(
        new Request("http://localhost/admin/listings/12?tab=notes"),
      ),
    ).toBe("/admin/listings/12?tab=notes");
    expect(
      returnPathFromRequest(new Request("http://localhost/admin/listings/12")),
    ).toBe("/admin/listings/12");
  });

  test("encodes the target into the login page's address", () => {
    expect(adminLoginPageHref(null)).toBe("/admin");
    expect(adminLoginPageHref("/admin/listings/12")).toBe(
      "/admin?return_url=%2Fadmin%2Flistings%2F12",
    );
  });
});
