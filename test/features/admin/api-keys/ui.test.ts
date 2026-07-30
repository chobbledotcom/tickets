import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { buildSessionCookie } from "#shared/cookies.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import { getApiKeysForUser, touchApiKeyLastUsed } from "#shared/db/api-keys.ts";
import { createSession } from "#shared/db/sessions.ts";
import {
  expectFlash,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
} from "#test-utils/assertions.ts";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  createTestApiKeyFull,
  testCookie,
} from "#test-utils/session.ts";
import {
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";

describeWithEnv("API keys admin UI", { db: true }, () => {
  /** GET the API keys page as the owner — optionally with a flash cookie —
   *  and return its HTML. */
  const getApiKeysHtml = async (flashCookie?: string): Promise<string> => {
    const cookie = await testCookie();
    const response = await handleRequest(
      mockRequest(
        flashCookie
          ? `/admin/api-keys?flash=${FLASH_TEST_ID}`
          : "/admin/api-keys",
        {
          headers: {
            cookie: flashCookie ? `${cookie}; ${flashCookie}` : cookie,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    return response.text();
  };

  describe("the create form and page", () => {
    test("serves the name box with its label, hint, bound, and required flag", async () => {
      // The expected attributes are written out here so a changed form
      // definition fails this test instead of moving the expectation along.
      const { apiKeyForm } = await import("#routes/admin/api-keys.ts");
      const html = apiKeyForm.render();
      expect(html).toContain("Name");
      const input = html.slice(html.indexOf('name="name"') - 200);
      expect(input).toContain('maxlength="100"');
      expect(input).toContain('placeholder="e.g. CI Pipeline"');
      expect(input).toContain("required");
    });

    test("GET /admin/api-keys shows the page", async () => {
      const html = await getApiKeysHtml();
      expect(html).toContain("API Keys");
      expect(html).toContain("Create API key");
    });

    test("GET /admin/api-keys shows existing keys with last used date", async () => {
      const { id } = await createTestApiKeyFull("Visible Key");
      await touchApiKeyLastUsed(id);

      const html = await getApiKeysHtml();
      expect(html).toContain("Visible Key");
      expect(html).not.toContain("Never");
      // The name links to the per-key manage page, not an inline delete link.
      expect(html).toContain(`href="/admin/api-keys/${id}"`);
    });

    test("GET /admin/api-keys without success or error params shows no messages", async () => {
      const html = await getApiKeysHtml();
      expect(html).not.toContain('class="success"');
      expect(html).not.toContain('class="error"');
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

  describe("flash messages", () => {
    test("shows a success message from the flash cookie", async () => {
      const html = await getApiKeysHtml(flashCookieHeader("done"));
      expect(html).toContain("done");
    });

    test("shows an error message from the flash cookie", async () => {
      const html = await getApiKeysHtml(flashCookieHeader("key failed", false));
      expect(html).toContain("key failed");
      expect(html).toContain("error");
    });

    test("shows a success message without a newline (no new key)", async () => {
      const html = await getApiKeysHtml(flashCookieHeader("Key updated"));
      expect(html).toContain("Key updated");
      expect(html).not.toContain("Copy your API key now");
    });

    test("a flash that is only a key still shows the copy panel, not a message", async () => {
      // The key sits after the newline; a flash that STARTS with the newline
      // has an empty message and only the key. The copy panel must still
      // appear — the split runs on position 0, which is a found position.
      const html = await getApiKeysHtml(flashCookieHeader("\nBARE-KEY-123"));
      expect(html).toContain("Copy your API key now");
      expect(html).toContain("BARE-KEY-123");
    });
  });

  describe("creating keys", () => {
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
      expect(await storedFeatureEnabled("apiKeys")).toBe(true);
    });

    test("does not create a key when enabling the feature fails", async () => {
      await setAdminFeatureEnabled("apiKeys", false);
      await withFeatureWriteFailure(async () => {
        const response = (
          await adminFormPost("/admin/api-keys", {
            name: "Unrecoverable key",
          })
        ).response;
        expectFlash(
          response,
          "SQLITE_CONSTRAINT: feature enable failed",
          false,
        );
        expect(await getApiKeysForUser(1)).toEqual([]);
        expect(await storedFeatureEnabled("apiKeys")).toBe(false);
      });
    });

    test("POST /admin/api-keys rejects empty name", async () => {
      const response = (await adminFormPost("/admin/api-keys", { name: "" }))
        .response;

      expect(response.status).toBe(302);
      expectFlash(response, "Name is required", false);
    });

    test("POST /admin/api-keys rejects missing name field", async () => {
      const response = (await adminFormPost("/admin/api-keys", {})).response;

      expect(response.status).toBe(302);
      expectFlash(response, "Name is required", false);
    });

    test("POST /admin/api-keys rejects name over 100 characters", async () => {
      const response = (
        await adminFormPost("/admin/api-keys", {
          name: "x".repeat(101),
        })
      ).response;

      expect(response.status).toBe(302);
      expectFlash(response, "Name must be under 100 characters", false);
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
  });
});
