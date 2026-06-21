import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { buildSessionCookie } from "#shared/cookies.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { recordApiKeyAttempt } from "#shared/db/api-key-attempts.ts";
import {
  countApiKeysForUser,
  createApiKey,
  deleteAllApiKeysForUser,
  deleteApiKey,
  getApiKeyByToken,
  getApiKeyForUser,
  getApiKeysForUser,
  touchApiKeyLastUsed,
} from "#shared/db/api-keys.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { createSession } from "#shared/db/sessions.ts";
import { MAX_APIKEY_ATTEMPTS } from "#shared/limits.ts";
import {
  assertJson,
  createTestApiKeyFull,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectRedirect,
  extractCsrfToken,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockRequest,
  requestAsApiKey,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describeWithEnv("API Keys", { db: true }, () => {
  describe("database operations", () => {
    test("creates and retrieves an API key", async () => {
      const { apiKey, id } = await createTestApiKeyFull();

      expect(id).toBeGreaterThan(0);
      expect(apiKey).toBeTruthy();

      const found = await getApiKeyByToken(apiKey);
      expect(found).not.toBeNull();
      expect(found!.user_id).toBe(1);
      expect(found!.id).toBe(id);
    });

    test("unwraps DATA_KEY from API key", async () => {
      const { apiKey } = await createTestApiKeyFull();

      const found = await getApiKeyByToken(apiKey);
      const unwrapped = await unwrapKeyWithToken(
        found!.wrapped_data_key,
        apiKey,
      );
      expect(unwrapped).not.toBeNull();
    });

    test("returns null for unknown token", async () => {
      const found = await getApiKeyByToken("nonexistent-token");
      expect(found).toBeNull();
    });

    test("throws for wrong token unwrap", async () => {
      const { apiKey } = await createTestApiKeyFull();

      const found = await getApiKeyByToken(apiKey);
      await expect(
        unwrapKeyWithToken(found!.wrapped_data_key, "wrong-token"),
      ).rejects.toThrow();
    });

    test("lists API keys for a user", async () => {
      const { dataKey } = await createTestApiKeyFull("Key A");
      await createApiKey(1, "Key B", dataKey, generateSecureToken);

      const keys = await getApiKeysForUser(1);
      expect(keys).toHaveLength(2);
      expect(keys[0]!.name).toBe("Key A");
      expect(keys[1]!.name).toBe("Key B");
    });

    test("counts API keys for a user", async () => {
      const { dataKey } = await createTestApiKeyFull("Key A");
      await createApiKey(1, "Key B", dataKey, generateSecureToken);

      expect(await countApiKeysForUser(1)).toBe(2);
      expect(await countApiKeysForUser(999)).toBe(0);
    });

    test("deletes an API key", async () => {
      const { id } = await createTestApiKeyFull();

      const deleted = await deleteApiKey(id, 1);
      expect(deleted).toBe(true);
      expect(await countApiKeysForUser(1)).toBe(0);
    });

    test("delete fails for wrong user", async () => {
      const { id } = await createTestApiKeyFull();

      const deleted = await deleteApiKey(id, 999);
      expect(deleted).toBe(false);
      expect(await countApiKeysForUser(1)).toBe(1);
    });

    test("deletes all API keys for a user", async () => {
      const { dataKey } = await createTestApiKeyFull("Key A");
      await createApiKey(1, "Key B", dataKey, generateSecureToken);

      await deleteAllApiKeysForUser(1);
      expect(await countApiKeysForUser(1)).toBe(0);
    });

    test("updates last_used timestamp", async () => {
      const { id } = await createTestApiKeyFull("Touch Test");

      await touchApiKeyLastUsed(id);
      const keys = await getApiKeysForUser(1);
      expect(keys[0]!.lastUsed).toBeTruthy();
    });

    test("gets a single API key by ID and user", async () => {
      const { id } = await createTestApiKeyFull("Lookup Key");

      const found = await getApiKeyForUser(id, 1);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Lookup Key");
    });

    test("getApiKeyForUser throws for wrong user", async () => {
      const { id } = await createTestApiKeyFull("Wrong User");

      await expect(getApiKeyForUser(id, 999)).rejects.toThrow();
    });

    test("lists empty array for user with no keys", async () => {
      const keys = await getApiKeysForUser(999);
      expect(keys).toHaveLength(0);
    });
  });

  describe("admin UI", () => {
    test("GET /admin/api-keys shows the page", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("API Keys");
      expect(html).toContain("Create API key");
    });

    test("POST /admin/api-keys creates a key and redirects with it", async () => {
      const cookie = await testCookie();

      // GET the page to get CSRF token
      const getResponse = await handleRequest(
        mockRequest("/admin/api-keys", { headers: { cookie } }),
      );
      const pageHtml = await getResponse.text();
      const csrfToken = extractCsrfToken(pageHtml);

      const body = new URLSearchParams({
        csrf_token: csrfToken!,
        name: "My Test Key",
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      const location = expectRedirect(response);
      const locationUrl = new URL(location, "http://localhost");
      locationUrl.searchParams.delete("flash");
      expect(locationUrl.pathname).toBe("/admin/api-keys");
      expectFlash(response, expect.stringContaining("API key created\n"));

      // Follow the redirect and verify the key is shown
      const flashCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith("flash_"))!;
      const redirectResponse = await handleRequest(
        mockRequest(location, {
          headers: { cookie: `${cookie}; ${flashCookie.split(";")[0]}` },
        }),
      );
      const html = await redirectResponse.text();
      expect(html).toContain("API key created");
      expect(html).toContain("Copy your API key now");
    });

    test("POST /admin/api-keys rejects empty name", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        csrf_token: csrfToken,
        name: "",
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      // Should redirect with error
      expect(response.status).toBe(302);
      expectFlash(response, "Name is required", false);
    });

    test("POST /admin/api-keys rejects missing name field", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Name is required", false);
    });

    test("POST /admin/api-keys rejects name over 100 characters", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        csrf_token: csrfToken,
        name: "x".repeat(101),
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Name must be under 100 characters", false);
    });

    test("POST /admin/api-keys/:id/delete returns 404 for nonexistent key", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        confirm_identifier: "anything",
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999/delete", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(404);
    });

    test("GET /admin/api-keys shows success message without newline (no new key)", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest(`/admin/api-keys?flash=${FLASH_TEST_ID}`, {
          headers: { cookie: `${cookie}; ${flashCookieHeader("Key updated")}` },
        }),
      );

      const html = await response.text();
      expect(html).toContain("Key updated");
      expect(html).not.toContain("Copy your API key now");
    });

    test("GET /admin/api-keys shows existing keys with last used date", async () => {
      const { id } = await createTestApiKeyFull("Visible Key");
      await touchApiKeyLastUsed(id);

      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys", { headers: { cookie } }),
      );

      const html = await response.text();
      expect(html).toContain("Visible Key");
      expect(html).not.toContain("Never");
      // The name links to the per-key manage page, not an inline delete link.
      expect(html).toContain(`href="/admin/api-keys/${id}"`);
    });

    test("GET /admin/api-keys/:id shows the manage page with a delete link", async () => {
      const { id } = await createTestApiKeyFull("Managed Key");
      const cookie = await testCookie();

      // A never-used key shows the "Never" placeholder for last used.
      const first = await handleRequest(
        mockRequest(`/admin/api-keys/${id}`, { headers: { cookie } }),
      );
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(firstHtml).toContain("Managed Key");
      expect(firstHtml).toContain(`/admin/api-keys/${id}/delete`);
      expect(firstHtml).toContain("Never");

      // Once used, the manage page renders the formatted last-used date.
      await touchApiKeyLastUsed(id);
      const second = await handleRequest(
        mockRequest(`/admin/api-keys/${id}`, { headers: { cookie } }),
      );
      const secondHtml = await second.text();
      expect(secondHtml).not.toContain("Never");
    });

    test("GET /admin/api-keys/:id returns 404 for a nonexistent key", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999", { headers: { cookie } }),
      );

      expect(response.status).toBe(404);
    });

    test("GET /admin/api-keys shows success message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest(`/admin/api-keys?flash=${FLASH_TEST_ID}`, {
          headers: { cookie: `${cookie}; ${flashCookieHeader("done")}` },
        }),
      );

      const html = await response.text();
      expect(html).toContain("done");
    });

    test("GET /admin/api-keys shows error message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest(`/admin/api-keys?flash=${FLASH_TEST_ID}`, {
          headers: {
            cookie: `${cookie}; ${flashCookieHeader("key failed", false)}`,
          },
        }),
      );

      const html = await response.text();
      expect(html).toContain("key failed");
      expect(html).toContain("error");
    });

    test("POST /admin/api-keys/:id/delete removes a key with name confirmation", async () => {
      const { id } = await createTestApiKeyFull("Doomed Key");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        confirm_identifier: "Doomed Key",
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(302);
      expect(await countApiKeysForUser(1)).toBe(0);
    });

    test("POST /admin/api-keys/:id/delete rejects wrong name", async () => {
      const { id } = await createTestApiKeyFull("My Key");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        confirm_identifier: "Wrong Name",
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      // The delete-confirmation page has no error slot of its own; the Layout
      // backstop renders the mismatch error, so the operator actually sees it.
      await expectFlashRedirect(
        `/admin/api-keys/${id}/delete`,
        expect.stringContaining("does not match"),
        false,
      )(response);
      expect(await countApiKeysForUser(1)).toBe(1);
    });

    test("GET /admin/api-keys/:id/delete shows confirmation page", async () => {
      const { id } = await createTestApiKeyFull("Confirm Key");

      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm Key");
      expect(html).toContain("confirm_identifier");
    });

    test("GET /admin/api-keys/:id/delete returns 404 for nonexistent key", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999/delete", {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("Bearer token authentication", () => {
    test("authenticates /api/admin/* request with Bearer token", async () => {
      await createTestListing({ name: "Bearer Test" });

      const { apiKey } = await createTestApiKeyFull("Auth Test");

      await assertJson(
        handleRequest(requestAsApiKey("/api/admin/listings", apiKey)),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("rejects Bearer token on admin HTML pages", async () => {
      const { apiKey } = await createTestApiKeyFull("Scope Test");

      // Bearer should NOT authenticate admin UI routes
      const dashboardResponse = await handleRequest(
        requestAsApiKey("/admin/api-keys/docs", apiKey),
      );
      expect(dashboardResponse.status).toBe(302);

      const settingsResponse = await handleRequest(
        requestAsApiKey("/admin/settings", apiKey),
      );
      expect(settingsResponse.status).toBe(302);

      const keysResponse = await handleRequest(
        requestAsApiKey("/admin/api-keys", apiKey),
      );
      expect(keysResponse.status).toBe(302);
    });

    test("rejects invalid Bearer token", async () => {
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", "invalid-token"),
      );

      expect(response.status).toBe(401);
    });

    test("locks out Bearer auth after too many failed attempts", async () => {
      const { apiKey } = await createTestApiKeyFull("Rate Limited");
      // Saturate the failed-attempt limit for the test's "direct" IP. Once
      // locked, even a valid key is rejected until the lockout expires.
      for (let i = 0; i < MAX_APIKEY_ATTEMPTS; i++) {
        await recordApiKeyAttempt("direct");
      }
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey),
      );
      expect(response.status).toBe(401);
    });

    test("rejects request without auth", async () => {
      const response = await handleRequest(mockRequest("/admin/api-keys/docs"));

      expect(response.status).toBe(302);
    });

    test("succeeds even when touchApiKeyLastUsed fails", async () => {
      await createTestListing({ name: "Touch Fail Test" });
      const { apiKey } = await createTestApiKeyFull("Resilient Auth");

      const apiKeysModule = await import("#shared/db/api-keys.ts");
      const stubTouch = stub(
        apiKeysModule.apiKeysApi,
        "touchApiKeyLastUsed",
        () => Promise.reject(new Error("DB error")),
      );

      try {
        const response = await handleRequest(
          requestAsApiKey("/api/admin/listings", apiKey),
        );
        expect(response.status).toBe(200);
      } finally {
        stubTouch.restore();
      }
    });
  });

  describe("admin UI edge cases", () => {
    test("GET /admin/api-keys without success or error params shows no messages", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys", { headers: { cookie } }),
      );

      const html = await response.text();
      expect(html).not.toContain('class="success"');
      expect(html).not.toContain('class="error"');
    });

    test("POST /admin/api-keys redirects when session has no wrapped data key", async () => {
      // Create a session without wrapped_data_key
      const token = generateSecureToken();
      const csrfToken = await signCsrfToken();
      const expires = Date.now() + 86400000;
      await createSession(token, csrfToken, expires, null, 1);
      const cookie = buildSessionCookie(token);

      const body = new URLSearchParams({
        csrf_token: csrfToken,
        name: "No Key Session",
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Session key unavailable", false);
    });

    test("GET /admin/api-keys/docs returns HTML docs via cookie auth", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys/docs", { headers: { cookie } }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("API Documentation");
      expect(html).toContain("Bearer");
    });
  });

  describe("admin JSON API", () => {
    test("GET /api/admin/listings returns listings via API key", async () => {
      await createTestListing({ name: "Test Listing" });

      const { apiKey } = await createTestApiKeyFull("Listings API");

      const body = await assertJson(
        handleRequest(requestAsApiKey("/api/admin/listings", apiKey)),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
          expect(body.listings.length).toBeGreaterThan(0);
          expect(body.admin_level).toBe("owner");
        },
      );

      // Verify snake_case keys and no internal fields
      const listing = body.listings[0];
      expect(listing.name).toBe("Test Listing");
      expect(listing.max_attendees).toBeDefined();
      expect(listing.attendee_count).toBeDefined();
      expect(listing.listing_type).toBeDefined();
      expect(listing.slug_index).toBeUndefined();
    });

    test("GET /api/admin/listings returns listings via cookie+CSRF", async () => {
      await createTestListing({ name: "Cookie Listing" });

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession("/api/admin/listings", { cookie, csrfToken }),
        ),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("GET /api/admin/listings returns 401 for invalid API key", async () => {
      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", "bad-key"),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/listings returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/listings"));

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key user no longer exists", async () => {
      const token = generateSecureToken();
      const keyIndex = await hmacHash(token);

      // Disable FK checks to insert an orphaned API key row
      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = OFF" });
      await getDb().execute(
        insert("api_keys", {
          created: new Date().toISOString(),
          key_index: keyIndex,
          last_used: "",
          name: "Ghost",
          user_id: 9999,
          wrapped_data_key: "dummy",
        }),
      );
      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = ON" });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", token),
      );

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key wrapped data key is corrupted", async () => {
      const { apiKey, id } = await createTestApiKeyFull("Corrupt Key");

      // Corrupt the wrapped_data_key in the DB
      await getDb().execute({
        args: ["corrupted-data", id],
        sql: "UPDATE api_keys SET wrapped_data_key = ? WHERE id = ?",
      });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/listings", apiKey),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/listings serves a cookie without a CSRF header", async () => {
      await createTestListing({ name: "CSRF Listing" });
      const cookie = await testCookie();

      // A safe GET carries no body and can't mutate state, so a cookie session
      // need not (and a feed/browser client often cannot) send an x-csrf-token
      // header to read a JSON endpoint.
      await assertJson(
        handleRequest(
          mockRequest("/api/admin/listings", {
            headers: { cookie },
          }),
        ),
        200,
        (body) => {
          expect(body.listings).toBeDefined();
        },
      );
    });

    test("request succeeds when touchApiKeyLastUsed fails (fire-and-forget)", async () => {
      await createTestListing({ name: "Touch Test" });
      const { apiKey } = await createTestApiKeyFull("Touch Test Key");

      // Make touchApiKeyLastUsed throw via test hook
      const { setTouchOverride } = await import("#shared/test-overrides.ts");
      setTouchOverride(new Error("touch failed"));

      try {
        const response = await handleRequest(
          requestAsApiKey("/api/admin/listings", apiKey),
        );
        // Request should succeed despite touchApiKeyLastUsed throwing
        expect(response.status).toBe(200);
      } finally {
        setTouchOverride(null);
      }
    });
  });
});
