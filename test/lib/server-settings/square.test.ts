import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { squareApi } from "#shared/square.ts";
import {
  adminFormPost,
  assertJson,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/square", () => {
    testRequiresAuth("/admin/settings/square", {
      body: {
        square_access_token: "EAAAl_test_123",
        square_location_id: "L_test_123",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: "invalid-csrf-token",
            square_access_token: "EAAAl_test_123",
            square_location_id: "L_test_123",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing square access token", async () => {
      const { response } = await adminFormPost("/admin/settings/square", {
        square_access_token: "",
        square_location_id: "L_test_123",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("rejects missing location ID", async () => {
      const { response } = await adminFormPost("/admin/settings/square", {
        square_access_token: "EAAAl_test_123",
        square_location_id: "",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("updates Square credentials successfully", async () => {
      const { response } = await adminFormPost("/admin/settings/square", {
        square_access_token: "EAAAl_test_new",
        square_location_id: "L_test_456",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Square credentials updated"),
      );
    });

    test("rejects an access token that looks like an application ID", async () => {
      const { response } = await adminFormPost("/admin/settings/square", {
        square_access_token: "sq0idp-EXAMPLE",
        square_location_id: "L_test_456",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("application ID or secret"),
        false,
      );
    });

    test("rejects a location ID that looks like an application ID", async () => {
      const { response } = await adminFormPost("/admin/settings/square", {
        square_access_token: "EAAAl_test_new",
        square_location_id: "sq0idp-EXAMPLE",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not a Location ID"),
        false,
      );
    });

    test("settings page shows Square is not configured initially", async () => {
      await settings.update.paymentProvider("square");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("No Square access token is configured");
      expect(html).not.toContain("square-test-btn");
    });

    test("settings page shows Square is configured after setting token", async () => {
      // Set the Square credentials
      await adminFormPost("/admin/settings/square", {
        square_access_token: "EAAAl_test_configured",
        square_location_id: "L_test_configured",
      });

      // Check the settings page shows it's configured
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("A Square access token is currently configured");
      expect(html).toContain("square-test-btn");
      expect(html).toContain("Test Connection");
    });
  });

  describe("POST /admin/settings/square-webhook", () => {
    testRequiresAuth("/admin/settings/square-webhook", {
      body: {
        square_webhook_signature_key: "sig_key_test",
      },
      method: "POST",
    });

    test("rejects missing webhook signature key", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/square-webhook",
        { square_webhook_signature_key: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("updates Square webhook key successfully", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/square-webhook",
        { square_webhook_signature_key: "sig_key_new" },
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Square webhook signature key updated"),
      );
    });

    test("rejects a signature key that looks like an application ID", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/square-webhook",
        { square_webhook_signature_key: "sq0idp-EXAMPLE" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not a webhook signature key"),
        false,
      );
    });

    test("rejects missing webhook signature key", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/square-webhook",
        { square_webhook_signature_key: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("updates Square webhook key successfully", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/square-webhook",
        { square_webhook_signature_key: "sig_key_new" },
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Square webhook signature key updated"),
      );
    });
  });

  describe("POST /admin/settings/square/test", () => {
    testRequiresAuth("/admin/settings/square/test", {
      body: {},
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square/test",
          { csrf_token: "invalid-csrf-token" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("returns JSON result when access token is not configured", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              accessToken: {
                error: "No Square access token configured",
                valid: false,
              },
              location: { configured: false },
              ok: false,
              webhook: { configured: false },
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/square/test",
          );
          expect(response.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(false);
            expect(json.accessToken.valid).toBe(false);
            expect(json.accessToken.error).toContain(
              "No Square access token configured",
            );
          });
        },
      );
    });

    test("returns success when all checks pass", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              accessToken: { mode: "sandbox", valid: true },
              location: {
                configured: true,
                locationId: "L_test_123",
                name: "Test Location",
                status: "ACTIVE",
              },
              ok: true,
              webhook: { configured: true },
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/square/test",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(true);
            expect(json.accessToken.valid).toBe(true);
            expect(json.accessToken.mode).toBe("sandbox");
            expect(json.location.configured).toBe(true);
            expect(json.location.name).toBe("Test Location");
            expect(json.webhook.configured).toBe(true);
          });
        },
      );
    });

    test("returns partial failure when token valid but location missing", async () => {
      await withMocks(
        () =>
          stub(squareApi, "testSquareConnection", () =>
            Promise.resolve({
              accessToken: { mode: "sandbox", valid: true },
              location: {
                configured: false,
                error: "No location ID configured",
              },
              ok: false,
              webhook: { configured: true },
            }),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/square/test",
          );
          await assertJson(Promise.resolve(response), 200, (json) => {
            expect(json.ok).toBe(false);
            expect(json.accessToken.valid).toBe(true);
            expect(json.location.configured).toBe(false);
            expect(json.location.error).toContain("No location ID configured");
          });
        },
      );
    });
  });

  describe("templates/admin/settings.tsx (Square webhook coverage)", () => {
    test("settings page shows Square webhook config when square provider set", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("EAAAl_test_123");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            cookie: await testCookie(),
            host: "localhost",
          },
        }),
      );
      await expectHtmlResponse(response, 200, "webhook", "full setup guide");
    });

    test("settings page shows Square webhook configured message", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");

      const response = await handleRequest(
        new Request("http://localhost/admin/settings", {
          headers: {
            cookie: await testCookie(),
            host: "localhost",
          },
        }),
      );
      await expectHtmlResponse(response, 200, "currently configured");
    });
  });

  test("logs activity when Square credentials are configured", async () => {
    await adminFormPost("/admin/settings/square", {
      square_access_token: "EAAAl_test_log",
      square_location_id: "L_test_log",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) => l.message.includes("Square credentials updated")),
    ).toBe(true);
  });

  test("logs activity when Square webhook key is configured", async () => {
    await adminFormPost("/admin/settings/square-webhook", {
      square_webhook_signature_key: "sig_key_log",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) =>
        l.message.includes("Square webhook signature key configured"),
      ),
    ).toBe(true);
  });
});
