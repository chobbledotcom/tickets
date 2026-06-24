import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { buildSessionCookie } from "#shared/cookies.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken } from "#shared/csrf.ts";
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
  expectErrorFlash,
  expectFlashRedirect,
  getAllActivityLog,
  mockFormRequest,
  setTestEnv,
  stubFetchStatus,
  testCookie,
  validEmail,
  withMocks,
} from "#test-utils";

const SUPERUSER_ROUTE = "/admin/settings/superuser";

/** POST a superuser_choice to the route (omit the argument for a missing field). */
const postChoice = (superuser_choice?: string) =>
  adminFormPost(
    SUPERUSER_ROUTE,
    superuser_choice === undefined ? {} : { superuser_choice },
  );

/** Run `body` with the credentials email succeeding (fetch → 200). */
const withEmailOk = (body: () => Promise<void>): Promise<void> =>
  withMocks(() => stubFetchStatus(200), body);

/** restoreAdminEmail + POST self-managed; returns the handler response. */
const postSelfManaged = (): ReturnType<typeof postChoice> => {
  restoreAdminEmail("admin@example.com");
  return postChoice("self-managed");
};

/** Assert `choice` is rejected with the "not available" flash for the given email. */
const expectNotAvailable = async (
  choice: string,
  email: string | undefined,
): Promise<void> => {
  restoreAdminEmail(email);
  const { response } = await postChoice(choice);
  expectErrorFlash(response, "Superuser is not available");
};

/** setupForEnable + POST enable-superuser with email OK; runs `body(response)`. */
const withEnableSuperuser = (
  body: (response: Response) => unknown,
): Promise<void> => {
  setupForEnable("admin@example.com");
  return withEmailOk(async () => {
    const { response } = await postChoice("enable-superuser");
    await body(response);
  });
};

/** Run `body` with the credentials email succeeding; `body` receives the
 *  `{ value }` ref into which the emailed password is recorded. */
const withCapturedPassword = (
  body: (captured: { value: string }) => Promise<void>,
): Promise<void> => {
  const captured = { value: "" };
  return withMocks(
    () =>
      stub(globalThis, "fetch", (_input, init) => {
        const reqBody = JSON.parse((init?.body as string) ?? "{}") as Record<
          string,
          unknown
        >;
        const match = String(reqBody.text ?? "").match(/Password: (.+)/);
        if (match) captured.value = match[1]!;
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    () => body(captured),
  );
};

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
      const { response } = await postSelfManaged();
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("logs activity 'Superuser recovery declined'", async () => {
      const { response } = await postSelfManaged();
      expect(response.status).toBe(302);
      const logs = await getAllActivityLog();
      expect(
        logs.some((l) => l.message === "Superuser recovery declined"),
      ).toBe(true);
    });

    test("redirects to /admin/settings with success flash", async () => {
      const { response } = await postSelfManaged();
      await expectFlashRedirect(
        "/admin/settings?form=settings-superuser#settings-superuser",
        "Superuser recovery declined",
      )(response);
    });

    test("is idempotent (already self-managed)", async () => {
      await postSelfManaged();
      const { response } = await postSelfManaged();
      expect(response.status).toBe(302);
      expect(settings.superuserChoice).toBe("self-managed");
    });
  });

  // ---------------------------------------------------------------------------
  // POST "self-managed" — errors
  // ---------------------------------------------------------------------------

  describe("POST self-managed — errors", () => {
    test("redirects with error when ADMIN_EMAIL_ADDRESS is unset", () =>
      expectNotAvailable("self-managed", undefined));

    test("redirects with error when ADMIN_EMAIL_ADDRESS is invalid", () =>
      expectNotAvailable("self-managed", "not-an-email"));

    test("redirects with already-exists message when derived username already exists", async () => {
      restoreAdminEmail("admin@example.com");
      await createUser("admin", "", null, "owner");
      const { response } = await postChoice("self-managed");
      expect(settings.superuserChoice).toBe("");
      expectErrorFlash(response, "already exists");
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — full success path
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — success path", () => {
    test("creates a user with the derived username", () =>
      withEnableSuperuser(async (response) => {
        expect(response.status).toBe(302);
        const user = await getUserByUsername("admin");
        expect(user).not.toBeNull();
      }));

    test("created user has a hashed password (not stored in plaintext)", () =>
      withEnableSuperuser(async () => {
        const user = await getUserByUsername("admin");
        expect(user!.password_hash).not.toBe("");
        expect(user!.password_hash).not.toContain("pass1234");
      }));

    test("created user has wrapped_data_key set", () =>
      withEnableSuperuser(async () => {
        const user = await getUserByUsername("admin");
        expect(user!.wrapped_data_key).not.toBeNull();
      }));

    test("created user's admin level decrypts to 'owner'", () =>
      withEnableSuperuser(async () => {
        const user = await getUserByUsername("admin");
        const { decryptAdminLevel } = await import("#shared/db/users.ts");
        const level = await decryptAdminLevel(user!);
        expect(level).toBe("owner");
      }));

    test("settings.superuserChoice persisted as 'enabled' after email success", () =>
      withEnableSuperuser((response) => {
        expect(response.status).toBe(302);
        expect(settings.superuserChoice).toBe("enabled");
      }));

    test("logActivity called with \"Superuser 'admin' enabled\"", () =>
      withEnableSuperuser(async () => {
        const logs = await getAllActivityLog();
        expect(
          logs.some((l) => l.message === "Superuser 'admin' enabled"),
        ).toBe(true);
      }));

    test("redirects to /admin/settings on success", () =>
      withEnableSuperuser((response) =>
        expectFlashRedirect(
          "/admin/settings?form=settings-superuser#settings-superuser",
          "Superuser enabled and credentials sent",
        )(response),
      ));

    test("generated password is 12 characters", async () => {
      await setupForEnable("admin@example.com");
      await withCapturedPassword(async (captured) => {
        await postChoice("enable-superuser");
        expect(captured.value.length).toBe(12);
      });
    });

    test("verifyUserPassword succeeds with the generated password", async () => {
      await setupForEnable("admin@example.com");
      await withCapturedPassword(async (captured) => {
        await postChoice("enable-superuser");
        const user = await getUserByUsername("admin");
        expect(user).not.toBeNull();
        const ok = await verifyUserPassword(user!, captured.value);
        expect(ok).toBeTruthy();
      });
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
      await withEmailOk(async () => {
        const { response } = await postChoice("enable-superuser");
        expect(response.status).toBe(302);
        expect(settings.superuserChoice).toBe("enabled");
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: missing env / existing user / validation
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: missing env", () => {
    test("redirects with error when ADMIN_EMAIL_ADDRESS is unset", () =>
      expectNotAvailable("enable-superuser", undefined));

    test("redirects with error when ADMIN_EMAIL_ADDRESS is invalid", () =>
      expectNotAvailable("enable-superuser", "not-an-email"));
  });

  describe("POST enable-superuser — error: existing user", () => {
    test("when user already exists AND is activated redirects with message", async () => {
      restoreAdminEmail("admin@example.com");
      const passwordHash = await hashPassword("test");
      await createUser("admin", passwordHash, "wrapped-bytes", "owner");
      const { response } = await postChoice("enable-superuser");
      expectErrorFlash(response, "already activated");
    });

    test("when user exists but is NOT activated redirects with username-exists message", async () => {
      restoreAdminEmail("admin@example.com");
      await createUser("admin", "", null, "owner");
      const { response } = await postChoice("enable-superuser");
      expectErrorFlash(response, "Username admin");
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: missing email config
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: missing email config", () => {
    test("redirects with error when neither DB nor host email config is set", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest(null);
      const { response } = await postChoice("enable-superuser");
      expectErrorFlash(response, "Email must be configured");
    });

    test("email config error is returned before any user is created", async () => {
      restoreAdminEmail("admin@example.com");
      setHostEmailConfigForTest(null);
      await postChoice("enable-superuser");
      const user = await getUserByUsername("admin");
      expect(user).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // POST "enable-superuser" — error: email sending fails
  // ---------------------------------------------------------------------------

  describe("POST enable-superuser — error: email sending fails", () => {
    const EMAIL_FAILURES: {
      name: string;
      fetchMock: () => { restore(): void };
    }[] = [
      {
        fetchMock: () => stubFetchStatus(500, "Error"),
        name: "when email returns non-2xx status, the newly created user is deleted",
      },
      {
        fetchMock: () =>
          stub(globalThis, "fetch", () =>
            Promise.reject(new Error("NetworkError")),
          ),
        name: "when email.send throws an exception, the user is deleted",
      },
      {
        fetchMock: () => stubFetchStatus(400, "Bad Request"),
        name: "when email returns status 400, user is still deleted",
      },
    ];

    for (const { name, fetchMock } of EMAIL_FAILURES) {
      test(name, async () => {
        await setupForEnable("admin@example.com");
        await withMocks(fetchMock, async () => {
          const { response } = await postChoice("enable-superuser");
          expect(response.status).toBe(302);
          const user = await getUserByUsername("admin");
          expect(user).toBeNull();
        });
      });
    }

    const DELETE_FAILURES: { name: string; rejection: unknown }[] = [
      {
        name: "when email fails and deleteUser throws an Error, still redirects successfully",
        rejection: new Error("DB delete failed"),
      },
      {
        name: "when email fails and deleteUser throws a non-Error, still redirects successfully",
        rejection: "non-error rejection",
      },
    ];

    for (const { name, rejection } of DELETE_FAILURES) {
      test(name, async () => {
        await setupForEnable("admin@example.com");
        const { getDb: getDbFn } = await import("#shared/db/client.ts");
        await withMocks(
          () => ({
            batchStub: stub(getDbFn(), "batch", () =>
              Promise.reject(rejection),
            ),
            fetchStub: stubFetchStatus(500, "Error"),
          }),
          async () => {
            const { response } = await postChoice("enable-superuser");
            expect(response.status).toBe(302);
          },
        );
      });
    }
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
    expectErrorFlash(response, "session lacks data key");
  });

  // ---------------------------------------------------------------------------
  // POST validation variants
  // ---------------------------------------------------------------------------

  describe("POST validation variants", () => {
    const INVALID_CHOICES: { name: string; choice: string | undefined }[] = [
      {
        choice: "",
        name: "POST with empty superuser_choice returns validation error",
      },
      {
        choice: undefined,
        name: "POST with missing superuser_choice field returns validation error",
      },
      {
        choice: "enable",
        name: "POST with arbitrary string like 'enable' returns validation error",
      },
      {
        choice: "Self-Managed",
        name: "POST with case variation 'Self-Managed' returns validation error",
      },
    ];

    for (const { name, choice } of INVALID_CHOICES) {
      test(name, async () => {
        restoreAdminEmail("admin@example.com");
        const { response } = await postChoice(choice);
        expectErrorFlash(response, "Invalid choice");
      });
    }

    test("POST with leading/trailing whitespace in choice value is trimmed and succeeds", async () => {
      restoreAdminEmail("admin@example.com");
      const { response } = await postChoice("  self-managed  ");
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
