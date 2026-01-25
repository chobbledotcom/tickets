import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { clearEncryptionKeyCache } from "#lib/crypto.ts";
import { resetSessionCache } from "#lib/db/sessions.ts";
import {
  createTestDbWithSetup,
  mockFormRequest,
  resetDb,
  TEST_ADMIN_PASSWORD,
  TEST_ENCRYPTION_KEY,
} from "#test-utils";
import { handleRequest } from "#src/server.ts";
import { getAuthenticatedSession, getPrivateKey } from "#routes/utils.ts";

// Set ALLOWED_DOMAIN for security middleware (required for login)
Deno.env.set("ALLOWED_DOMAIN", "localhost");

/**
 * A different test encryption key (also 32 bytes base64-encoded)
 * Simulates what happens when DB_ENCRYPTION_KEY is rotated
 */
const DIFFERENT_ENCRYPTION_KEY =
  "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";

/** Helper to create request with session cookie */
const requestWithSession = (path: string, cookie: string): Request =>
  new Request(`http://localhost${path}`, {
    headers: { cookie, host: "localhost" },
  });

describe("old session key handling", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  afterEach(() => {
    // Restore original encryption key for cleanup
    Deno.env.set("DB_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    clearEncryptionKeyCache();
    resetDb();
  });

  test("invalidates session and shows login when DB_ENCRYPTION_KEY changes", async () => {
    // Step 1: Login to get a valid session with wrapped_data_key
    const loginResponse = await handleRequest(
      mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
    );
    expect(loginResponse.status).toBe(302);
    const sessionCookie = loginResponse.headers.get("set-cookie") || "";
    expect(sessionCookie).toContain("__Host-session=");

    // Step 2: Verify session works before key change
    const responseBefore = await handleRequest(
      requestWithSession("/admin/", sessionCookie),
    );
    expect(responseBefore.status).toBe(200);
    const htmlBefore = await responseBefore.text();
    expect(htmlBefore).toContain("Logout"); // User is authenticated

    // Verify crypto works before key change
    const sessionBefore = await getAuthenticatedSession(
      requestWithSession("/admin/", sessionCookie),
    );
    expect(sessionBefore).not.toBeNull();
    const privateKeyBefore = await getPrivateKey(
      sessionBefore!.token,
      sessionBefore!.wrappedDataKey,
    );
    expect(privateKeyBefore).not.toBeNull(); // Crypto works fine

    // Step 3: Simulate DB_ENCRYPTION_KEY rotation (e.g., security incident, key compromise)
    Deno.env.set("DB_ENCRYPTION_KEY", DIFFERENT_ENCRYPTION_KEY);
    clearEncryptionKeyCache();
    resetSessionCache();

    // Step 4: User returns with their old session cookie
    // Session should be invalidated because wrapped_data_key can't be unwrapped
    const responseAfter = await handleRequest(
      requestWithSession("/admin/", sessionCookie),
    );

    // User sees the login page, not the dashboard
    // (getAuthenticatedSession returns null, so /admin/ shows login form)
    expect(responseAfter.status).toBe(200);
    const htmlAfter = await responseAfter.text();
    expect(htmlAfter).toContain("Login"); // Shows login form
    expect(htmlAfter).not.toContain("Logout"); // Not authenticated

    // Session is invalidated - getAuthenticatedSession returns null
    const sessionAfter = await getAuthenticatedSession(
      requestWithSession("/admin/", sessionCookie),
    );
    expect(sessionAfter).toBeNull(); // Session was invalidated

    // Note: The error "E_KEY_DERIVATION" is logged with detail:
    // "Session has invalid wrapped_data_key, likely due to DB_ENCRYPTION_KEY rotation. User must re-login."
  });
});
