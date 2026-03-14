import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  createTestManagerSession,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describe("admin debug footer", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("owner sees footer on admin dashboard", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toContain("Chobble Tickets");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
  });

  test("footer contains SQL queries", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toContain("SELECT");
    expect(html).toContain("ms</li>");
  });

  test("footer shows query count in summary", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toMatch(/\d+ quer(y|ies)/);
  });

  test("footer shows timing breakdown", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toContain("sql ");
    expect(html).toContain("other ");
  });

  test("footer shows cache stats", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toContain("cached");
  });

  test("footer is inside a <footer> element before </body>", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    const footerIdx = html.indexOf("<footer");
    const bodyCloseIdx = html.indexOf("</body>");
    expect(footerIdx).toBeGreaterThan(-1);
    expect(bodyCloseIdx).toBeGreaterThan(footerIdx);
  });

  test("footer uses debug-footer CSS class", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).toContain('class="debug-footer"');
  });

  test("unauthenticated users do not see footer", async () => {
    const response = await handleRequest(mockRequest("/admin/"));
    const html = await response.text();
    expect(html).not.toContain("Chobble Tickets");
  });

  test("manager sees footer with branding and debug info on dashboard", async () => {
    const managerCookie = await createTestManagerSession();
    const managerResponse = await awaitTestRequest("/admin/", {
      cookie: managerCookie,
    });
    const managerHtml = await managerResponse.text();
    expect(managerHtml).toContain("Events");
    expect(managerHtml).toContain("Chobble Tickets");
    expect(managerHtml).toContain("debug-footer");
  });

  test("footer not injected for POST logout redirect", async () => {
    const logoutResponse = await handleRequest(
      mockFormRequest(
        "/admin/logout",
        { csrf_token: await testCsrfToken() },
        await testCookie(),
      ),
    );
    const logoutBody = await logoutResponse.text();
    expect(logoutBody).not.toContain("Chobble Tickets");
  });

  test("owner sees footer on settings page", async () => {
    const settingsResult = await adminGet("/admin/settings");
    const settingsHtml = await settingsResult.response.text();
    expect(settingsHtml).toContain("Chobble Tickets");
  });

  test("footer excluded from CSV export responses", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const exportResult = await adminGet(`/admin/event/${event.id}/export`);
    expect(exportResult.response.headers.get("content-type")).toContain(
      "text/csv",
    );
    const exportBody = await exportResult.response.text();
    expect(exportBody).not.toContain("Chobble Tickets");
  });

  test("returns null for unmatched admin GET routes", async () => {
    // A path that doesn't match any admin route falls through to 404
    const { response } = await adminGet("/admin/nonexistent-page-xyz");
    expect(response.status).toBe(404);
  });
});
