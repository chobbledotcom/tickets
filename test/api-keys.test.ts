import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildSessionCookie } from "#lib/cookies.ts";
import {
  generateSecureToken,
  hmacHash,
  unwrapKeyWithToken,
} from "#lib/crypto.ts";

import { signCsrfToken } from "#lib/csrf.ts";
import {
  countApiKeysForUser,
  createApiKey,
  deleteAllApiKeysForUser,
  deleteApiKey,
  getApiKeyByToken,
  getApiKeyForUser,
  getApiKeysForUser,
  touchApiKeyLastUsed,
} from "#lib/db/api-keys.ts";
import { getDb } from "#lib/db/client.ts";
import { createSession } from "#lib/db/sessions.ts";
import { handleRequest } from "#routes";
import {
  assertJson,
  createTestApiKeyFull,
  createTestEvent,
  describeWithEnv,
  expectFlash,
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
        name: "My Test Key",
        csrf_token: csrfToken!,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
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
        name: "",
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
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
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Name is required", false);
    });

    test("POST /admin/api-keys rejects name over 100 characters", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        name: "x".repeat(101),
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Name must be under 100 characters", false);
    });

    test("POST /admin/api-keys/:id/delete returns error for nonexistent key", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const body = new URLSearchParams({
        csrf_token: csrfToken,
        confirm_identifier: "anything",
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999/delete", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
      );

      expect(response.status).toBe(404);
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
        csrf_token: csrfToken,
        confirm_identifier: "Doomed Key",
      });
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
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
        csrf_token: csrfToken,
        confirm_identifier: "Wrong Name",
      });
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
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
      await createTestEvent({ name: "Bearer Test" });

      const { apiKey } = await createTestApiKeyFull("Auth Test");

      await assertJson(
        handleRequest(requestAsApiKey("/api/admin/events", apiKey)),
        200,
        (body) => {
          expect(body.events).toBeDefined();
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
        requestAsApiKey("/api/admin/events", "invalid-token"),
      );

      expect(response.status).toBe(401);
    });

    test("rejects request without auth", async () => {
      const response = await handleRequest(mockRequest("/admin/api-keys/docs"));

      expect(response.status).toBe(302);
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
        name: "No Key Session",
        csrf_token: csrfToken,
      });
      const response = await handleRequest(
        mockRequest("/admin/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
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
    test("GET /api/admin/events returns events via API key", async () => {
      await createTestEvent({ name: "Test Event" });

      const { apiKey } = await createTestApiKeyFull("Events API");

      const body = await assertJson(
        handleRequest(requestAsApiKey("/api/admin/events", apiKey)),
        200,
        (body) => {
          expect(body.events).toBeDefined();
          expect(body.events.length).toBeGreaterThan(0);
          expect(body.admin_level).toBe("owner");
        },
      );

      // Verify snake_case keys and no internal fields
      const event = body.events[0];
      expect(event.name).toBe("Test Event");
      expect(event.max_attendees).toBeDefined();
      expect(event.attendee_count).toBeDefined();
      expect(event.event_type).toBeDefined();
      expect(event.slug_index).toBeUndefined();
    });

    test("GET /api/admin/events returns events via cookie+CSRF", async () => {
      await createTestEvent({ name: "Cookie Event" });

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession("/api/admin/events", { cookie, csrfToken }),
        ),
        200,
        (body) => {
          expect(body.events).toBeDefined();
        },
      );
    });

    test("GET /api/admin/events returns 401 for invalid API key", async () => {
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", "bad-key"),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/events returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/events"));

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key user no longer exists", async () => {
      const token = generateSecureToken();
      const keyIndex = await hmacHash(token);

      // Disable FK checks to insert an orphaned API key row
      await getDb().execute({ sql: "PRAGMA foreign_keys = OFF", args: [] });
      await getDb().execute({
        sql: `INSERT INTO api_keys (user_id, key_index, wrapped_data_key, name, created, last_used)
              VALUES (?, ?, ?, ?, ?, '')`,
        args: [9999, keyIndex, "dummy", "Ghost", new Date().toISOString()],
      });
      await getDb().execute({ sql: "PRAGMA foreign_keys = ON", args: [] });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", token),
      );

      expect(response.status).toBe(401);
    });

    test("returns 401 when API key wrapped data key is corrupted", async () => {
      const { apiKey, id } = await createTestApiKeyFull("Corrupt Key");

      // Corrupt the wrapped_data_key in the DB
      await getDb().execute({
        sql: "UPDATE api_keys SET wrapped_data_key = ? WHERE id = ?",
        args: ["corrupted-data", id],
      });

      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey),
      );

      expect(response.status).toBe(401);
    });

    test("GET /api/admin/events returns 401 for cookie without CSRF header", async () => {
      await createTestEvent({ name: "CSRF Event" });
      const cookie = await testCookie();

      const response = await handleRequest(
        mockRequest("/api/admin/events", {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(403);
    });
  });
});
