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
 *  path the login flow can send the user to. A query value's encoded
 *  characters (%26, %25) must survive, so the accepted target is the raw
 *  text, not its decoded shape. */
const ACCEPTED: readonly (readonly [string, string])[] = [
  ["/admin/listings/12", "/admin/listings/12"],
  ["/admin/listings/12?tab=notes", "/admin/listings/12?tab=notes"],
  ["/admin/settings/", "/admin/settings/"],
  ["/admin/", "/admin/"],
  ["/admin/café", "/admin/caf%C3%A9"],
  ["/admin/listings/12?filter=A%26B", "/admin/listings/12?filter=A%26B"],
  ["/admin/listings/12?q=100%25", "/admin/listings/12?q=100%25"],
  [
    "/admin/listings/12?share=https://x.example",
    "/admin/listings/12?share=https://x.example",
  ],
  [
    "/admin/users?invite=https%3A%2F%2Fchobble.example%2Fjoin%2Fabc123",
    "/admin/users?invite=https%3A%2F%2Fchobble.example%2Fjoin%2Fabc123",
  ],
];

/** The attack shapes and other values the rule must refuse: addresses for
 *  another site (direct, protocol-relative, percent-encoded), backslashes,
 *  control characters, climbs out of the admin area, the login and logout
 *  pages themselves, malformed escapes, and anything whose path is not an
 *  admin path. The query carries parameter data, so a URL inside a query
 *  value is not an attack. */
const REFUSED: readonly string[] = [
  "//evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "https://evil.com/admin",
  "http://evil.com/admin/listings/12",
  "javascript:alert(1)",
  "%2F%2Fevil.com",
  "%5Cevil.com",
  "%2Fadmin%2Flistings",
  "%zz",
  "/admin/listings%zz",
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

  test("hands over a target only for a navigable GET request", () => {
    // Only a GET is navigable after login: a POST-only path would answer 404
    // when the browser follows the redirect with GET.
    const target = "http://localhost/admin/listings/12";
    expect(returnPathFromRequest(new Request(target))).toBe(
      "/admin/listings/12",
    );
    expect(returnPathFromRequest(new Request(target, { method: "HEAD" }))).toBe(
      "/admin/listings/12",
    );
    expect(returnPathFromRequest(new Request(target, { method: "POST" }))).toBe(
      null,
    );
  });

  test("keeps a query value's encoded characters through the login round trip", () => {
    // The gate hands the raw path to the login page, the page hides it in
    // the form, and the form's value is checked again on POST. The filter
    // value A%26B must still parse as one value A&B after login, and a
    // percent sign in a value must not read as a malformed escape.
    for (const input of [
      "/admin/listings/12?filter=A%26B",
      "/admin/listings/12?q=100%25",
      "/admin/users?invite=https%3A%2F%2Fchobble.example%2Fjoin%2Fabc123",
    ]) {
      const target = adminReturnPath(input);
      expect(target, input).toBe(input);
      const href = adminLoginPageHref(target);
      const carried = new Request(`http://localhost${href}`);
      expect(returnPathFromQuery(carried), input).toBe(input);
    }
  });

  test("encodes the target into the login page's address", () => {
    expect(adminLoginPageHref(null)).toBe("/admin");
    expect(adminLoginPageHref("/admin/listings/12")).toBe(
      "/admin?return_url=%2Fadmin%2Flistings%2F12",
    );
  });
});
