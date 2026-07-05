/**
 * Integration tests for the admin debug footer — verifying WHEN the footer
 * is injected into responses. The HTML shape of the footer itself is tested
 * as a unit in test/lib/footer.test.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminGet,
  assertAdminHtml,
  awaitTestRequest,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  mockFormRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Marker that uniquely identifies the debug footer in a response. */
const FOOTER_MARKER = '<footer class="admin-footer">';

describeWithEnv("admin debug footer injection", { db: true }, () => {
  test("is injected into authenticated owner admin GET responses", async () => {
    await assertAdminHtml("/admin/", FOOTER_MARKER);
  });

  test("is injected for manager sessions (not just owners)", async () => {
    const managerCookie = await createTestManagerSession();
    const response = await awaitTestRequest("/admin/", {
      cookie: managerCookie,
    });
    const html = await response.text();
    expect(html).toContain(FOOTER_MARKER);
  });

  test("is NOT injected for unauthenticated requests to admin paths", async () => {
    const response = await handleRequest(mockRequest("/admin/"));
    const html = await response.text();
    expect(html).not.toContain(FOOTER_MARKER);
  });

  test("is NOT injected for public (non-admin) pages", async () => {
    const { settings } = await import("#shared/db/settings.ts");
    await settings.update.showPublicSite(true);
    const response = await handleRequest(mockRequest("/"));
    const html = await response.text();
    expect(html).not.toContain(FOOTER_MARKER);
  });

  test("is NOT injected for POST responses (no query log on mutations)", async () => {
    const response = await handleRequest(
      mockFormRequest(
        "/admin/logout",
        { csrf_token: await testCsrfToken() },
        await testCookie(),
      ),
    );
    const body = await response.text();
    expect(body).not.toContain(FOOTER_MARKER);
  });

  test("is NOT injected into non-HTML responses (e.g. CSV export)", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const response = await adminGet(`/admin/listing/${listing.id}/export`);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const body = await response.text();
    expect(body).not.toContain(FOOTER_MARKER);
  });
});

describeWithEnv("admin debug footer contents", { db: true }, () => {
  test("summary reflects the queries run to build the actual page", async () => {
    // Rendering the admin dashboard will execute at least one SQL query.
    // The summary must report a positive query count and positive SQL time.
    const html = await assertAdminHtml("/admin/", FOOTER_MARKER);

    const footerMatch = html.match(
      /<footer class="admin-footer">[\s\S]*?<\/footer>/,
    );
    expect(footerMatch).not.toBeNull();
    const footer = footerMatch![0];

    const queryCountMatch = footer.match(/(\d+) quer(?:y|ies)/);
    expect(queryCountMatch).not.toBeNull();
    expect(Number(queryCountMatch![1])).toBeGreaterThan(0);
  });

  test("lists the SQL statements executed while rendering the page", async () => {
    // The page must run at least one SELECT; assert it appears in the log.
    const html = await assertAdminHtml("/admin/", FOOTER_MARKER);
    expect(html).toContain("SQL queries");
    expect(html).toMatch(/<li>SELECT[^<]*&mdash;\s*\d+\.\d+ms<\/li>/);
  });

  test("renders after the page's main content (so timing reflects the full render)", async () => {
    const html = await assertAdminHtml("/admin/", FOOTER_MARKER);
    const mainIdx = html.indexOf("<main");
    const footerIdx = html.indexOf(FOOTER_MARKER);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(mainIdx);
  });
});
