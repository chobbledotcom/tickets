import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { TokenHash } from "#crypto/sealed.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import type { Session } from "#types";

const mkSession = (token: string): Session => ({
  csrf_token: "csrf",
  expires: Date.now() + 86400000,
  // Hand-crafted stored token hash — test fixture cast.
  token: token as TokenHash,
  user_id: 1,
  wrapped_data_key: null,
});

describe("adminSessionsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders session rows", () => {
    const sessions = [
      {
        csrf_token: "csrf1",
        expires: Date.now() + 86400000,
        // Hand-crafted stored token hash — test fixture cast.
        token: "abcdefghijklmnop" as TokenHash,
        user_id: 1,
        wrapped_data_key: null,
      },
      {
        csrf_token: "csrf2",
        expires: Date.now() + 86400000,
        // Hand-crafted stored token hash — test fixture cast.
        token: "qrstuvwxyz123456" as TokenHash,
        user_id: 2,
        wrapped_data_key: null,
      },
    ];
    const html = adminSessionsPage(
      sessions,
      "abcdefghijklmnop",
      OWNER_SESSION,
      "",
    );
    assertStringIncludes(html, "abcdefgh...");
    assertStringIncludes(html, "qrstuvwx...");
    assertStringIncludes(html, "Current");
  });

  test("renders empty state when no sessions", () => {
    const html = adminSessionsPage([], "some-token", OWNER_SESSION, "");
    assertStringIncludes(html, "No sessions");
  });

  test("marks the row that matches the current token as current", () => {
    const s = mkSession("abcdefghijklmnop");
    const html = adminSessionsPage([s], s.token, OWNER_SESSION, "");
    assertStringIncludes(html, "Current");
  });

  test("does not mark a row whose token is not the current one", () => {
    const s = mkSession("abcdefghijklmnop");
    const html = adminSessionsPage([s], "a-different-token", OWNER_SESSION, "");
    assert(
      !html.includes("Current"),
      "the value should not contain the searched item",
    );
  });

  test("shows the logout-others control with the count of other sessions", () => {
    const current = mkSession("aaaaaaaaaaaaaaaa");
    const html = adminSessionsPage(
      [current, mkSession("bbbbbbbbbbbbbbbb"), mkSession("cccccccccccccccc")],
      current.token,
      OWNER_SESSION,
      "",
    );
    // Two sessions other than the current one.
    assertStringIncludes(html, "Log out of all other sessions (2)");
  });

  test("hides the logout-others control when there are no other sessions", () => {
    const s = mkSession("aaaaaaaaaaaaaaaa");
    const html = adminSessionsPage([s], s.token, OWNER_SESSION, "");
    assert(
      !html.includes("Log out of all other sessions"),
      "the value should not contain the searched item",
    );
  });
});
