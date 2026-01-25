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

  test("user with old session key sees blank screen when DB_ENCRYPTION_KEY changes", async () => {
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
    // BUG: The session appears valid but crypto operations silently fail
    const responseAfter = await handleRequest(
      requestWithSession("/admin/", sessionCookie),
    );

    // BUG DEMONSTRATION:
    // The user sees the admin dashboard (200 OK, "Logout" link visible)
    // but their session is effectively broken - they cannot decrypt any PII
    expect(responseAfter.status).toBe(200);
    const htmlAfter = await responseAfter.text();
    expect(htmlAfter).toContain("Logout"); // User appears logged in

    // The session is returned as "valid" even though crypto is broken
    const sessionAfter = await getAuthenticatedSession(
      requestWithSession("/admin/", sessionCookie),
    );
    expect(sessionAfter).not.toBeNull(); // Session appears valid
    expect(sessionAfter?.wrappedDataKey).toBeDefined(); // Has wrapped key

    // BUT: The private key derivation fails silently
    // This is because wrappedDataKey was encrypted with the OLD DB_ENCRYPTION_KEY
    // but unwrapKeyWithToken uses the NEW key in its PBKDF2 salt
    const privateKeyAfter = await getPrivateKey(
      sessionAfter!.token,
      sessionAfter!.wrappedDataKey,
    );
    expect(privateKeyAfter).toBeNull(); // Crypto silently fails!

    // EXPECTED BEHAVIOR:
    // User should be redirected to login (302 to /admin/) when their session
    // has an invalid wrapped_data_key, rather than being shown a broken dashboard
    //
    // ACTUAL BEHAVIOR (BUG):
    // - User sees the dashboard (appears logged in)
    // - Any page that tries to decrypt attendee PII will either:
    //   a) Show encrypted/garbled data
    //   b) Throw an error causing 500/blank screen
    //   c) Silently fail showing empty data
    // - User is stuck and doesn't know they need to re-login
    //
    // FIX OPTIONS:
    // 1. Validate wrapped_data_key can be unwrapped in getAuthenticatedSession()
    // 2. Add a "key version" to wrapped_data_key and invalidate on mismatch
    // 3. Delete all sessions when DB_ENCRYPTION_KEY changes (ops procedure)

    console.log(
      "BUG CONFIRMED: User has valid-looking session but crypto operations fail",
    );
  });
});
