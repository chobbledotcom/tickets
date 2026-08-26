/**
 * Branch cover for the invite routes
 * GET /admin/users — the list, its invite link, and its flash message
 * GET /admin/user/new — the invite form
 * POST /admin/users — the invite itself
 *
 * Sits beside the story `@story:access.inviting-someone-to-help`: the story
 * owns the owner's journey through the rendered pages, so these own who may
 * reach each address at all, and the sends only a crafted POST can make — a
 * role the form never offers, and a name the browser's own required rule
 * would never let through.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllUsers } from "#db/users.ts";
import { t } from "#i18n";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("who may reach the invite pages", () => {
    testRequiresAuth("/admin/users");
    testRequiresAuth("/admin/user/new");
    testRequiresAuth("/admin/users", {
      body: {
        admin_level: "manager",
        username: "newuser",
      },
      method: "POST",
    });

    test("serves the invite form to the owner", async () => {
      await expectHtmlResponse(
        await adminGet("/admin/user/new"),
        200,
        "Invite User",
        'action="/admin/users"',
      );
    });
  });

  describe("what the list carries besides the people", () => {
    test("shows the one-time link the owner was just given", async () => {
      const response = await awaitTestRequest(
        `/admin/users?invite=${encodeURIComponent(
          "https://localhost/join/abc123",
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "https://localhost/join/abc123",
        "Invite link",
      );
    });

    test("shows a message left behind by an action on another page", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/users?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("User deleted successfully")}`,
        },
      );
      await expectHtmlResponse(
        response,
        200,
        "User deleted successfully",
        'class="success"',
      );
    });
  });

  describe("sends the invite form itself could never make", () => {
    /** Post an invite the rendered form would not offer, and insist the site
     * refused it for the stated reason without adding anybody. */
    const expectRefused = async (
      body: Record<string, string>,
      reason: string,
    ): Promise<void> => {
      const before = (await getAllUsers()).length;
      const { response } = await adminFormPost("/admin/users", body);
      await expectFlashRedirect(
        "/admin/user/new",
        expect.stringContaining(reason),
        false,
      )(response);
      expect((await getAllUsers()).length).toBe(before);
    };

    test("refuses a role the form never offers", async () => {
      // The rendered form lists the site's own roles, so only a crafted send
      // can carry one that is not among them.
      await expectRefused(
        { admin_level: "superadmin", username: "newuser" },
        t("error.invalid_role"),
      );
    });

    test("refuses a blank name", async () => {
      // The name box is required, so a browser blocks this before it is sent.
      await expectRefused(
        { admin_level: "manager", username: "" },
        `${t("common.username")} is required`,
      );
    });

    test("refuses a name already in use, whatever role it asks for", async () => {
      // The story covers the owner meeting this refusal on the page; this one
      // pins that the check runs before anything is written, so an invite that
      // would have reserved the name leaves nothing behind.
      await expectRefused(
        { admin_level: "manager", username: TEST_ADMIN_USERNAME },
        t("error.username_taken"),
      );
    });
  });
});
