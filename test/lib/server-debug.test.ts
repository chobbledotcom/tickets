import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminGet,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("server (admin debug)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/debug", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/debug"));
      expectAdminRedirect(response);
    });

    test("renders debug page when authenticated", async () => {
      const { response } = await adminGet("/admin/debug");
      await expectHtmlResponse(response, 200, "Debug Info");
    });

    test("shows breadcrumb back to settings", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain('href="/admin/settings"');
      expect(html).toContain("Settings");
    });

    test("shows Apple Wallet section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Apple Wallet");
      expect(html).toContain("DB config");
      expect(html).toContain("Env var config");
      expect(html).toContain("Active source");
      expect(html).toContain("Pass Type ID");
    });

    test("shows Payments section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Payments");
      expect(html).toContain("Provider");
      expect(html).toContain("API key");
      expect(html).toContain("Webhook");
    });

    test("shows Email section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Email");
      expect(html).toContain("Provider (DB)");
      expect(html).toContain("From address");
      expect(html).toContain("Host provider (env)");
    });

    test("shows Notifications section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Notifications (ntfy)");
      expect(html).toContain("NTFY URL");
    });

    test("shows Bunny Storage section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Bunny Storage (images)");
      expect(html).toContain("Storage zone");
    });

    test("shows Bunny CDN section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Bunny CDN");
      expect(html).toContain("CDN management");
      expect(html).toContain("CDN hostname");
      expect(html).toContain("Custom domain");
    });

    test("shows Database section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Database");
      expect(html).toContain("DB_URL");
    });

    test("shows Domain section with ALLOWED_DOMAIN", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Domain");
      expect(html).toContain("ALLOWED_DOMAIN");
    });

    test("does not expose secret keys or full URLs", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).not.toContain("sk_test_");
      expect(html).not.toContain("sk_live_");
      expect(html).not.toContain("ntfy.sh");
    });

    test("shows Configured/Not configured badges", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Not configured");
    });

    test("shows no secrets disclaimer", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("No secrets or keys are shown");
    });
  });
});
