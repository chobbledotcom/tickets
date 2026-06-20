import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { createInvitedUser, getUserByUsername } from "#shared/db/users.ts";
import {
  assertPublicHtml,
  createTestInvite,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirectWithFlash,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  requireJoinCsrfToken,
  submitJoinForm,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("login flow", () => {
    test("login with username and password", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: TEST_ADMIN_PASSWORD,
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expectRedirectWithFlash("/admin", "Logged in")(response);
      const sessionCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(sessionCookie).toBeDefined();
    });

    test("login with wrong username returns 401", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: TEST_ADMIN_PASSWORD,
          username: "nonexistent",
        }),
      );
      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Username or password was wrong"),
        false,
      )(response);
    });

    test("login with wrong password returns 401", async () => {
      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "wrongpassword",
          username: TEST_ADMIN_USERNAME,
        }),
      );
      expectRedirectWithFlash(
        "/admin",
        expect.stringContaining("Username or password was wrong"),
        false,
      )(response);
    });

    test("login page shows username field", async () => {
      await assertPublicHtml("/admin/", "username");
    });
  });

  describe("join flow", () => {
    test("GET /join/:code returns 404 for invalid code", async () => {
      const response = await handleRequest(mockRequest("/join/invalidcode123"));
      await expectHtmlResponse(response, 404, "invalid");
    });

    test("GET /join/:code returns join page for valid invite", async () => {
      const { inviteCode } = await createTestInvite("joiner");

      const joinResponse = await handleRequest(
        mockRequest(`/join/${inviteCode}`),
      );
      expect(joinResponse.status).toBe(200);
      const joinHtml = await joinResponse.text();
      expect(joinHtml).toContain("joiner");
      expect(joinHtml).toContain("password");
    });

    test("GET /join/complete shows confirmation page", async () => {
      await assertPublicHtml("/join/complete", "Password Set");
    });

    test("POST /join/:code self-activates the invited user", async () => {
      const { inviteCode } = await createTestInvite("joiner2");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });

      expectRedirectWithFlash(
        "/join/complete",
        "Password set successfully",
      )(joinPostResponse);

      // Joining unwraps the DATA_KEY handoff and re-wraps it under the new
      // password (v2), so the user is active immediately — no admin step.
      const user = await getUserByUsername("joiner2");
      expect(user!.wrapped_data_key).not.toBeNull();
      expect(user!.kek_version).toBe(2);
    });

    test("POST /join/:code tells a stale replay the invite is invalid", async () => {
      // Race/replay: the invite is consumed elsewhere after this request has
      // already read a (now stale) row that still shows the handoff. The guarded
      // single-use UPDATE in acceptInvite then changes no row, and the handler
      // must surface that as an invalid invite — never "password set".
      const { inviteCode } = await createTestInvite("stale-replay");

      // Warm this isolate's user cache with the handoff-present row and capture a
      // valid CSRF token from the rendered form.
      const getResponse = await handleRequest(
        mockRequest(`/join/${inviteCode}`),
      );
      const csrf = requireJoinCsrfToken(await getResponse.text());

      // Simulate another isolate consuming the invite without invalidating our
      // cache: clear the handoff straight on the row, leaving our view stale.
      const { executeWithoutCacheInvalidation } = await import(
        "#shared/db/client.ts"
      );
      const consumed = (await getUserByUsername("stale-replay"))!;
      await executeWithoutCacheInvalidation(
        "UPDATE users SET invite_wrapped_data_key = NULL WHERE id = ?",
        [consumed.id],
      );

      const response = await handleRequest(
        mockFormRequest(`/join/${inviteCode}`, {
          csrf_token: csrf,
          password: "replaypass123",
          password_confirm: "replaypass123",
        }),
      );

      expectRedirectWithFlash(
        `/join/${inviteCode}`,
        expect.stringContaining("invalid"),
        false,
      )(response);
      // The replay set no password — the account never bound to it.
      expect((await getUserByUsername("stale-replay"))!.wrapped_data_key).toBe(
        null,
      );
    });

    test("POST /join/:code rejects mismatched passwords", async () => {
      const { inviteCode } = await createTestInvite("joiner3");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "differentpassword",
      });

      expectRedirectWithFlash(
        `/join/${inviteCode}`,
        expect.stringContaining("do not match"),
        false,
      )(joinPostResponse);
    });

    test("POST /join/:code rejects short passwords", async () => {
      const { inviteCode } = await createTestInvite("joiner4");

      const joinPostResponse = await submitJoinForm(inviteCode, {
        password: "short",
        password_confirm: "short",
      });

      expectRedirectWithFlash(
        `/join/${inviteCode}`,
        expect.stringContaining("8 characters"),
        false,
      )(joinPostResponse);
    });
  });

  describe("join flow (expired invite)", () => {
    test("GET /join/:code returns 410 for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#shared/db/users.ts");
      const codeHash = await hashInviteCode("expired-code-123");
      await createInvitedUser("expired-join", "manager", codeHash, expiry);

      const response = await handleRequest(
        mockRequest("/join/expired-code-123"),
      );
      await expectHtmlResponse(response, 410, "expired");
    });

    test("POST /join/:code returns 410 for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const { hashInviteCode } = await import("#shared/db/users.ts");
      const codeHash = await hashInviteCode("expired-post-123");
      await createInvitedUser("expired-post-user", "manager", codeHash, expiry);

      const response = await handleRequest(
        mockFormRequest("/join/expired-post-123", {
          csrf_token: "fake",
          password: "pass12345678",
          password_confirm: "pass12345678",
        }),
      );
      expect(response.status).toBe(410);
    });
  });

  describe("join flow (CSRF validation)", () => {
    test("POST /join/:code rejects invalid CSRF token", async () => {
      const { inviteCode } = await createTestInvite("csrf-test-user");

      const response = await handleRequest(
        mockFormRequest(`/join/${inviteCode}`, {
          csrf_token: "wrong",
          password: "newpassword123",
          password_confirm: "newpassword123",
        }),
      );
      expectRedirectWithFlash(
        `/join/${inviteCode}`,
        expect.stringContaining("try again"),
        false,
      )(response);
    });

    test("POST /join/:code rejects missing CSRF token", async () => {
      const { inviteCode } = await createTestInvite("csrf-missing-user");

      const response = await handleRequest(
        mockFormRequest(`/join/${inviteCode}`, {
          csrf_token: "token",
          password: "newpassword123",
          password_confirm: "newpassword123",
        }),
      );
      expect(response.status).toBe(302);
    });

    test("POST /join/:code rejects form without csrf_token field", async () => {
      const { inviteCode } = await createTestInvite("csrf-nofield-user");

      const body = "password=newpassword123&password_confirm=newpassword123";
      const response = await handleRequest(
        new Request(`http://localhost/join/${inviteCode}`, {
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(302);
    });

    test("POST /join/:code rejects missing password fields", async () => {
      const { inviteCode } = await createTestInvite("validation-user");

      const response = await submitJoinForm(inviteCode, {
        password: "",
        password_confirm: "",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("join.ts edge cases", () => {
    test("POST /join/:code withValidInvite extracts code from params", async () => {
      const response = await handleRequest(
        mockFormRequest("/join/nonexistent-code", {
          csrf_token: "csrf",
          password: "testpass123",
          password_confirm: "testpass123",
        }),
      );
      expect(response.status).toBe(404);
    });
  });
});
