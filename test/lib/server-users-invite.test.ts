import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllUsers } from "#shared/db/users.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  TEST_ADMIN_USERNAME,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("GET /admin/users", () => {
    testRequiresAuth("/admin/users");

    test("shows users list when authenticated as owner", async () => {
      const response = await adminGet("/admin/users");
      await expectHtmlResponse(response, 200, TEST_ADMIN_USERNAME, "owner");
    });
  });

  describe("GET /admin/users (with query params)", () => {
    test("displays invite link from query param", async () => {
      const response = await awaitTestRequest(
        "/admin/users?invite=" +
          encodeURIComponent("https://localhost/join/abc123"),
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "https://localhost/join/abc123",
        "Invite link",
      );
    });

    test("displays success message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/users?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "User deleted successfully",
          )}`,
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

  describe("GET /admin/user/new", () => {
    testRequiresAuth("/admin/user/new");

    test("renders invite user form when authenticated as owner", async () => {
      const response = await adminGet("/admin/user/new");
      await expectHtmlResponse(
        response,
        200,
        "Invite User",
        'action="/admin/users"',
      );
    });
  });

  describe("POST /admin/users (invite)", () => {
    testRequiresAuth("/admin/users", {
      body: {
        admin_level: "manager",
        username: "newuser",
      },
      method: "POST",
    });

    test("creates invited user and shows invite link", async () => {
      const { response } = await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "newmanager",
      });

      expect(response.status).toBe(302);
      const location = expectRedirect(response);
      expect(decodeURIComponent(location)).toContain("/join/");

      const users = await getAllUsers();
      expect(users.length).toBe(2);
    });

    test("rejects duplicate username", async () => {
      const { response } = await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: TEST_ADMIN_USERNAME,
      });

      await expectFlashRedirect(
        "/admin/user/new",
        expect.stringContaining("already taken"),
        false,
      )(response);
    });

    test("rejects invalid role", async () => {
      const { response } = await adminFormPost("/admin/users", {
        admin_level: "superadmin",
        username: "newuser",
      });

      await expectFlashRedirect(
        "/admin/user/new",
        expect.stringContaining("Invalid role"),
        false,
      )(response);
    });
  });

  describe("POST /admin/users (form validation)", () => {
    test("rejects missing username", async () => {
      const { response } = await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "",
      });
      expect(response.status).toBe(302);
    });
  });
});
