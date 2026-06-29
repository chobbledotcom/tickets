import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { Session } from "#shared/types.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

const mkSession = (token: string): Session => ({
  csrf_token: "csrf",
  expires: Date.now() + 86400000,
  token,
  user_id: 1,
  wrapped_data_key: null,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminSessionsPage", () => {
  test("renders session rows", () => {
    const sessions = [
      {
        csrf_token: "csrf1",
        expires: Date.now() + 86400000,
        token: "abcdefghijklmnop",
        user_id: 1,
        wrapped_data_key: null,
      },
      {
        csrf_token: "csrf2",
        expires: Date.now() + 86400000,
        token: "qrstuvwxyz123456",
        user_id: 2,
        wrapped_data_key: null,
      },
    ];
    const html = adminSessionsPage(
      sessions,
      "abcdefghijklmnop",
      TEST_SESSION,
      "",
    );
    expect(html).toContain("abcdefgh...");
    expect(html).toContain("qrstuvwx...");
    expect(html).toContain("Current");
  });

  test("renders empty state when no sessions", () => {
    const html = adminSessionsPage([], "some-token", TEST_SESSION, "");
    expect(html).toContain("No sessions");
  });

  test("marks the row that matches the current token as current", () => {
    const s = mkSession("abcdefghijklmnop");
    const html = adminSessionsPage([s], s.token, TEST_SESSION, "");
    expect(html).toContain("Current");
  });

  test("does not mark a row whose token is not the current one", () => {
    const s = mkSession("abcdefghijklmnop");
    const html = adminSessionsPage([s], "a-different-token", TEST_SESSION, "");
    expect(html).not.toContain("Current");
  });

  test("shows the logout-others control with the count of other sessions", () => {
    const current = mkSession("aaaaaaaaaaaaaaaa");
    const html = adminSessionsPage(
      [current, mkSession("bbbbbbbbbbbbbbbb"), mkSession("cccccccccccccccc")],
      current.token,
      TEST_SESSION,
      "",
    );
    // Two sessions other than the current one.
    expect(html).toContain("Log out of all other sessions (2)");
  });

  test("hides the logout-others control when there are no other sessions", () => {
    const s = mkSession("aaaaaaaaaaaaaaaa");
    const html = adminSessionsPage([s], s.token, TEST_SESSION, "");
    expect(html).not.toContain("Log out of all other sessions");
  });
});
