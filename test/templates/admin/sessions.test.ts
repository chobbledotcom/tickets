import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

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
});
