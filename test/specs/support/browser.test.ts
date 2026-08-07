// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import { sessionCookie } from "#test/specs/support/evidence.ts";

// jscpd:ignore-end

const browserWithCookies = (cookies: ReadonlyMap<string, string>) => ({
  debugCookies: () => new Map(cookies),
});

describe("sessionCookie", () => {
  test("returns only the configured admin session cookie", () => {
    const name = getSessionCookieName();

    expect(
      sessionCookie(
        browserWithCookies(
          new Map([
            ["theme", "dark"],
            [name, "editor-session"],
          ]),
        ),
      ),
    ).toBe(`${name}=editor-session`);
  });

  test("refuses a browser without an admin session cookie", () => {
    expect(() => sessionCookie(browserWithCookies(new Map()))).toThrow(
      "The browser has no admin session cookie",
    );
  });
});
