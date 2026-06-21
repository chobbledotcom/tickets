import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { buildSessionCookie } from "#shared/cookies.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createUser,
  getUserByUsername,
  verifyUserPassword,
} from "#shared/db/users.ts";
import { setHostEmailConfigForTest } from "#shared/email.ts";
import {
  adminFormPost,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  mockFormRequest,
  setTestEnv,
  testCookie,
  validEmail,
  withMocks,
} from "#test-utils";

const SUPERUSER_ROUTE = "/admin/settings/superuser";

// ---------------------------------------------------------------------------
// Route setup and auth guards
// ---------------------------------------------------------------------------

describeWithEnv("server (admin settings superuser)", { db: true }, () => {
  afterEach(() => {
    setHostEmailConfigForTest(null);
  });

  test("POST /admin/settings/superuser returns 403 for non-owner session", async () => {
    const managerCookie = await createTestManagerSession();
    const response = await awaitTestRequest(SUPERUSER_ROUTE, {
      cookie: managerCookie,
      data: { superuser_choice: "self-managed" },
      method: "POST",
    });
    expect(response.status).toBe(403);
  });

  test("POST /admin/settings/superuser redirects for unauthenticated request", async () => {
    const response = await handleRequest(
      mockFormRequest(SUPERUSER_ROUTE, { csrf_token: "fake" }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
  });

  test("POST /admin/settings/superuser requires CSRF token", async () => {
    const cookie = await testCookie();
    const response = await handleRequest(
      mockFormRequest(
        SUPERUSER_ROUTE,
        { superuser_choice: "self-managed" },
        cookie,
      ),
    );
    await expect(response.text()).resolves.toContain("Invalid CSRF token");
    expect(response.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // POST "self-managed" — success
  // ---------------------------------------------------------------------------

  describe("POST self-managed — success", () => {
    test("persists superuserChoice to 'self-managed'", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("logs activity 'Superuser recovery declined'", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message === "Superuser recovery declined"),
      ).toBe(true);
    });

    test("redirects to /admin/settings with success flash", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      await expectFlashRedirect(
        "/admin/settings?form=settings-superuser#settings-superuser",
        "Superuser recovery declined",
      )(response);
    });

    test("is idempotent (already self-managed)", async () => {
      restoreAdminEmail("admin@example.com");
      await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("self-managed");
    });
  });

  // ---------------------------------------------------------------------------
  // POST "self-managed" — errors
  // ---------------------------------------------------------------------------

  describe("POST self-managed — errors", () => {
    test("redirects with error when ADMIN_EMAIL_ADDRESS is unset", async () => {
      restoreAdminEmail(undefined);
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Superuser is not available"),
        false,
      );
    });

    test("redirects with error when ADMIN_EMAIL_ADDRESS is invalid", async () => {
      restoreAdminEmail("not-an-email");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Superuser is not available"),
        false,
      );
    });

    test("redirects with already-exists message when derived username already exists", async () => {
      restoreAdminEmail("admin@example.com");
      await createUser("admin", "", null, "owner");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "self-managed",
      });
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("");
      expectFlash(response, expect.stringContaining("already exists"), false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — full success path
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — success path", () => {
    test("creates a user with the derived username", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          const user = await getUserByUsername("admin");
          expect(user).not.toBeNull();
        },
      );
    });

    test("created user has a hashed password (not stored in plaintext)", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          const user = await getUserByUsername("admin");
          expect(user!.password_hash).not.toBe("");
          expect(user!.password_hash).not.toContain("pass1234");
        },
      );
    });

    test("created user has wrapped_data_key set", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          const user = await getUserByUsername("admin");
          expect(user!.wrapped_data_key).not.toBeNull();
        },
      );
    });

    test("created user's admin level decrypts to 'owner'", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          const user = await getUserByUsername("admin");
          const { decryptAdminLevel } = await import("#shared/db/users.ts");
          const level = await decryptAdminLevel(user!);
          expect(level).toBe("owner");
        },
      );
    });

    test("settings.superuserChoice persisted as 'enabled' after email success", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          expect(settings.superuserChoice).toBe("enabled");
        },
      );
    });

    test("logActivity called with \"Superuser 'admin' enabled\"", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          const logs = await getAllActivityLog();
          expect(
            logs.some((l) => l.message === "Superuser 'admin' enabled"),
          ).toBe(true);
        },
      );
    });

    test("redirects to /admin/settings on success", async () => {
      await setupForEnable("admin@example.com");
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          await expectFlashRedirect(
            "/admin/settings?form=settings-superuser#settings-superuser",
            "Superuser enabled and credentials sent",
          )(response);
        },
      );
    });

    test("generated password is 12 characters", async () => {
      await setupForEnable("admin@example.com");
      let capturedPassword = "";
      await withMocks(
        () =>
          stub(globalThis, "fetch", (_input, init) => {
            const body = JSON.parse((init?.body as string) ?? "{}") as Record<
              string,
              unknown
            >;
            const text = String(body.text ?? "");
            const match = text.match(/Password: (.+)/);
            if (match) capturedPassword = match[1]!;
            return Promise.resolve(new Response(null, { status: 200 }));
          }),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(capturedPassword.length).toBe(12);
        },
      );
    });

    test("verifyUserPassword succeeds with the generated password", async () => {
      await setupForEnable("admin@example.com");
      let capturedPassword = "";
      await withMocks(
        () =>
          stub(globalThis, "fetch", (_input, init) => {
            const body = JSON.parse((init?.body as string) ?? "{}") as Record<
              string,
              unknown
            >;
            const text = String(body.text ?? "");
            const match = text.match(/Password: (.+)/);
            if (match) capturedPassword = match[1]!;
            return Promise.resolve(new Response(null, { status: 200 }));
          }),
        async () => {
          await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          const user = await getUserByUsername("admin");
          expect(user).not.toBeNull();
          const ok = await verifyUserPassword(user!, capturedPassword);
          expect(ok).toBeTruthy();
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — email config fallback
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — email config fallback", () => {
    test("falls back to host email config when DB email config is null", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "host-key",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(null, { status: 200 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          expect(settings.superuserChoice).toBe("enabled");
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: missing env
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: missing env", () => {
    test("redirects with error when ADMIN_EMAIL_ADDRESS is unset", async () => {
      restoreAdminEmail(undefined);
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Superuser is not available"),
        false,
      );
    });

    test("redirects with error when ADMIN_EMAIL_ADDRESS is invalid", async () => {
      restoreAdminEmail("not-an-email");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Superuser is not available"),
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: existing user
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: existing user", () => {
    test("when user already exists AND is activated redirects with message", async () => {
      restoreAdminEmail("admin@example.com");
      const passwordHash = await hashPassword("test");
      await createUser("admin", passwordHash, "wrapped-bytes", "owner");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("already activated"),
        false,
      );
    });

    test("when user exists but is NOT activated redirects with username-exists message", async () => {
      restoreAdminEmail("admin@example.com");
      await createUser("admin", "", null, "owner");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Username admin"), false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: missing email config
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: missing email config", () => {
    test("redirects with error when neither DB nor host email config is set", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest(null);
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Email must be configured"),
        false,
      );
    });

    test("email config error is returned before any user is created", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest(null);
      await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable-superuser",
      });
      const user = await getUserByUsername("admin");
      expect(user).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: email sending fails
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: email sending fails", () => {
    test("when email returns non-2xx status, the newly created user is deleted", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "k",
        fromAddress: validEmail("f@e.com"),
        provider: "resend",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Error", { status: 500 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          const user = await getUserByUsername("admin");
          expect(user).toBeNull();
        },
      );
    });

    test("when email.send throws an exception, the user is deleted", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "k",
        fromAddress: validEmail("f@e.com"),
        provider: "resend",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.reject(new Error("NetworkError")),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          const user = await getUserByUsername("admin");
          expect(user).toBeNull();
        },
      );
    });

    test("when email returns status 400, user is still deleted", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "k",
        fromAddress: validEmail("f@e.com"),
        provider: "resend",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Bad Request", { status: 400 })),
          ),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
          const user = await getUserByUsername("admin");
          expect(user).toBeNull();
        },
      );
    });

    test("when email fails and deleteUser throws an Error, still redirects successfully", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "k",
        fromAddress: validEmail("f@e.com"),
        provider: "resend",
      });
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      await withMocks(
        () => ({
          batchStub: stub(getDbFn(), "batch", () =>
            Promise.reject(new Error("DB delete failed")),
          ),
          fetchStub: stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Error", { status: 500 })),
          ),
        }),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
        },
      );
    });

    test("when email fails and deleteUser throws a non-Error, still redirects successfully", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest({
        apiKey: "k",
        fromAddress: validEmail("f@e.com"),
        provider: "resend",
      });
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      await withMocks(
        () => ({
          batchStub: stub(getDbFn(), "batch", () =>
            Promise.reject("non-error rejection"),
          ),
          fetchStub: stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Error", { status: 500 })),
          ),
        }),
        async () => {
          const { response } = await adminFormPost(SUPERUSER_ROUTE, {
            superuser_choice: "enable-superuser",
          });
          expect(response.status).toBe(302);
        },
      );
    });
  });

  test("POST enable-superuser returns error when session lacks wrappedDataKey", async () => {
    restoreAdminEmail("admin@example.com");
    setHostEmailConfigForTest({
      apiKey: "k",
      fromAddress: validEmail("f@e.com"),
      provider: "resend",
    });
    const user = await getUserByUsername("testadmin");
    expect(user).not.toBeNull();
    const token = generateSecureToken();
    const csrf = await signCsrfToken();
    await createSession(token, csrf, Date.now() + 60_000, null, user!.id);
    const cookie = buildSessionCookie(token);
    const response = await handleRequest(
      mockFormRequest(
        SUPERUSER_ROUTE,
        { csrf_token: csrf, superuser_choice: "enable-superuser" },
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    expectFlash(
      response,
      expect.stringContaining("session lacks data key"),
      false,
    );
  });

  // ---------------------------------------------------------------------------
  // POST validation variants
  // ---------------------------------------------------------------------------

  describe("POST validation variants", () => {
    test("POST with empty superuser_choice returns validation error", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid choice"), false);
    });

    test("POST with missing superuser_choice field returns validation error", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {});
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid choice"), false);
    });

    test("POST with arbitrary string like 'enable' returns validation error", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "enable",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid choice"), false);
    });

    test("POST with case variation 'Self-Managed' returns validation error", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "Self-Managed",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid choice"), false);
    });

    test("POST with leading/trailing whitespace in choice value is trimmed and succeeds", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await adminFormPost(SUPERUSER_ROUTE, {
        superuser_choice: "  self-managed  ",
      });
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("self-managed");
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const envRestore: { current: (() => void) | undefined } = {
  current: undefined,
};

function restoreAdminEmail(value: string | undefined): void {
  envRestore.current?.();
  envRestore.current = setTestEnv({ ADMIN_EMAIL_ADDRESS: value });
}

function setupForEnable(email: string): void {
  restoreAdminEmail(email);
  setHostEmailConfigForTest({
    apiKey: "k",
    fromAddress: validEmail("f@e.com"),
    provider: "resend",
  });
}
