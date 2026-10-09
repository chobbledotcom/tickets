import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectLoginRedirectWithReturn,
  landedAt,
} from "#test-utils/login-redirect.ts";

/** A 302 response with one Location header. */
const redirect = (location: string): Response =>
  new Response(null, { headers: { location }, status: 302 });

describe("the login redirect assertions", () => {
  test("landedAt parses a same-origin redirect target", () => {
    expect(landedAt(redirect("/admin?return_url=%2Fadmin")).pathname).toBe(
      "/admin",
    );
  });

  test("landedAt refuses an off-site redirect target", () => {
    expect(() =>
      landedAt(
        redirect("https://evil.com/admin?return_url=%2Fadmin%2Fsettings"),
      ),
    ).toThrow();
  });

  test("the login redirect assertion accepts the carried page", () => {
    expectLoginRedirectWithReturn("/admin/settings")(
      redirect("/admin?return_url=%2Fadmin%2Fsettings"),
    );
  });

  test("the login redirect assertion refuses an off-site redirect", () => {
    expect(() =>
      expectLoginRedirectWithReturn("/admin/settings")(
        redirect("https://evil.com/admin?return_url=%2Fadmin%2Fsettings"),
      ),
    ).toThrow();
  });
});
