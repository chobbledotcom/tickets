import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  loginAsAdmin,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  requireJoinCsrfToken,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("owner debug footer", () => {
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

  test("manager does not see footer", async () => {
    // Create and activate a manager user
    const { cookie: ownerCookie, csrfToken: ownerCsrf } = await loginAsAdmin();

    const inviteResponse = await handleRequest(
      mockFormRequest("/admin/users", {
        username: "manager1",
        admin_level: "manager",
        csrf_token: ownerCsrf,
      }, ownerCookie),
    );
    const inviteUrl = inviteResponse.headers.get("location") ?? "";
    const inviteMatch = inviteUrl.match(/invite=([^&]+)/);
    const inviteLink = decodeURIComponent(inviteMatch![1] as string);
    const inviteToken = inviteLink.split("/join/")[1]!;

    // Set password for manager
    const joinPageResponse = await handleRequest(mockRequest(`/join/${inviteToken}`));
    const joinHtml = await joinPageResponse.text();
    const joinCsrf = requireJoinCsrfToken(joinHtml);
    await handleRequest(
      mockFormRequest(`/join/${inviteToken}`, {
        password: "managerpass123",
        password_confirm: "managerpass123",
        csrf_token: joinCsrf,
      }),
    );

    // Activate the manager
    await handleRequest(
      mockFormRequest("/admin/users/2/activate", {
        csrf_token: ownerCsrf,
      }, ownerCookie),
    );

    // Login as manager
    const loginResponse = await handleRequest(
      await mockAdminLoginRequest({
        username: "manager1",
        password: "managerpass123",
      }),
    );
    const managerCookie = loginResponse.headers.get("set-cookie") ?? "";

    // Manager GET should not contain the footer
    const response = await awaitTestRequest("/admin/", { cookie: managerCookie });
    const html = await response.text();
    expect(html).toContain("Events");
    expect(html).not.toContain("Chobble Tickets");
  });

  test("footer not injected for POST responses", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();
    // POST to logout — it returns a redirect, not HTML, so no footer
    const response = await handleRequest(
      mockFormRequest("/admin/logout", { csrf_token: csrfToken }, cookie),
    );
    const body = await response.text();
    expect(body).not.toContain("Chobble Tickets");
  });

  test("owner sees footer on other admin pages", async () => {
    const { response } = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).toContain("Chobble Tickets");
  });

  test("footer not injected for non-HTML GET responses", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const { response } = await adminGet(`/admin/event/${event.id}/export`);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const body = await response.text();
    expect(body).not.toContain("Chobble Tickets");
  });

  test("returns null for unmatched admin GET routes", async () => {
    // A path that doesn't match any admin route falls through to 404
    const { response } = await adminGet("/admin/nonexistent-page-xyz");
    expect(response.status).toBe(404);
  });
});
