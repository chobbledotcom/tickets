/** The admin listings index page (`/admin/listings`): the shell every role
 * opens it through, the staff and editor table variants, the deactivated and
 * multi-booking sections, and the role-gated export and guide links. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminListingsPage } from "#templates/admin/dashboard.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { AdminSession } from "#types";

describe("adminListingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders active listings first and deactivated listings second", () => {
    const active = testListingWithCount({
      active: true,
      id: 1,
      name: "Active Show",
    });
    const inactive = testListingWithCount({
      active: false,
      id: 2,
      name: "Old Show",
    });
    const html = adminListingsPage([active, inactive], OWNER_SESSION);
    assertStringIncludes(html, 'class="active" href="/admin/listings"');
    assertStringIncludes(html, "Active Show");
    assertStringIncludes(html, "Deactivated");
    assertStringIncludes(html, "Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
    // The Listings section sub-nav offers the catalog import entry point.
    assertStringIncludes(html, 'href="/admin/catalog/import"');
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      OWNER_SESSION,
    );
    assert(!html.includes("Deactivated"));
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    assertStringIncludes(html, 'class="table-actions"');
    assertStringIncludes(html, 'href="/admin/listings/csv"');
    assertStringIncludes(html, "Export CSV");
  });

  const populated = [
    testListingWithCount({ attendee_count: 25, id: 1, name: "Active Show" }),
    testListingWithCount({ attendee_count: 7, id: 3, name: "Third" }),
    testListingWithCount({ active: false, id: 2, name: "Old Show" }),
  ];
  const EDITOR_SESSION: AdminSession = { adminLevel: "editor" };

  test("renders the complete owner page: shell, staff table, sections, CSV, footer", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage(populated, OWNER_SESSION);

      assertStringIncludes(html, "<title>Listings</title>");
      assertStringIncludes(html, 'class="page-regions admin-page"');
      assertStringIncludes(html, '<a class="active" href="/admin/listings">');
      assertStringIncludes(html, "<th>Revenue</th>");
      assertStringIncludes(
        html,
        '<a href="/admin/listings/csv">Export CSV</a>',
      );
      assertStringIncludes(html, "<h2>Deactivated</h2>");
      assertStringIncludes(html, "Old Show");
      assertStringIncludes(
        html,
        "<details><summary>Multi-booking link</summary>",
      );
      assertStringIncludes(
        html,
        '<a href="/admin/log">Log</a> &middot; <a href="/admin/guide">Guide</a>',
      );
      assertStringIncludes(
        html,
        '<p class="guide-footer"><a class="guide-link" href="/admin/guide#listings">',
      );
      assertStringIncludes(html, "<span>Listings guide</span>");
      assertStringIncludes(html, '<footer class="admin-footer">');
    });
  });

  test("renders the editor variant: money-free table, sections, no CSV or guide", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage(populated, EDITOR_SESSION);

      assertStringIncludes(html, '<a class="active" href="/admin/listings">');
      assertStringIncludes(html, "<th>Listing name</th>");
      assert(!html.includes("<th>Revenue</th>"));
      assert(!html.includes('href="/admin/listings/csv"'));
      assertStringIncludes(html, "<h2>Deactivated</h2>");
      assertStringIncludes(
        html,
        "<details><summary>Multi-booking link</summary>",
      );
      assert(!html.includes('href="/admin/guide#listings"'));
      assertStringIncludes(html, '<footer class="admin-footer">');
      assertStringIncludes(html, '<a href="/admin/logout">Log out</a>');
    });
  });

  test("renders the complete owner empty state with the CSV export", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage([], OWNER_SESSION);

      assertStringIncludes(html, "<title>Listings</title>");
      assertStringIncludes(html, '<a class="active" href="/admin/listings">');
      assertStringIncludes(html, "No listings yet");
      assertStringIncludes(
        html,
        '<a href="/admin/listings/csv">Export CSV</a>',
      );
      assert(!html.includes("<h2>Deactivated</h2>"));
      assert(!html.includes("multi-booking-list"));
      assertStringIncludes(
        html,
        '<p class="guide-footer"><a class="guide-link" href="/admin/guide#listings">',
      );
      assertStringIncludes(html, "<span>Listings guide</span>");
      assertStringIncludes(html, '<footer class="admin-footer">');
    });
  });

  test("renders the editor empty page without the staff-only links", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage([], EDITOR_SESSION);

      assertStringIncludes(html, "No listings yet");
      assert(!html.includes('href="/admin/listings/csv"'));
      assert(!html.includes('href="/admin/guide#listings"'));
      assertStringIncludes(html, '<footer class="admin-footer">');
    });
  });
});
