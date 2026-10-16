/** The admin listings index page (`/admin/listings`): the shell every role
 * opens it through, the staff and editor table variants, the deactivated and
 * multi-booking sections, and the role-gated export and guide links. */

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
    expect(html).toContain('class="active" href="/admin/listings"');
    expect(html).toContain("Active Show");
    expect(html).toContain("Deactivated");
    expect(html).toContain("Old Show");
    expect(html.indexOf("Active Show")).toBeLessThan(html.indexOf("Old Show"));
    // The Listings section sub-nav offers the catalog import entry point.
    expect(html).toContain('href="/admin/catalog/import"');
  });

  test("omits the deactivated heading when every listing is active", () => {
    const html = adminListingsPage(
      [testListingWithCount({ active: true, name: "Active Show" })],
      OWNER_SESSION,
    );
    expect(html).not.toContain("Deactivated");
  });

  test("links to the listings CSV export", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    expect(html).toContain('class="table-actions"');
    expect(html).toContain('href="/admin/listings/csv"');
    expect(html).toContain("Export CSV");
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

      expect(html).toContain("<title>Listings</title>");
      expect(html).toContain('class="page-regions admin-page"');
      expect(html).toContain('<a class="active" href="/admin/listings">');
      expect(html).toContain("<th>Revenue</th>");
      expect(html).toContain('<a href="/admin/listings/csv">Export CSV</a>');
      expect(html).toContain("<h2>Deactivated</h2>");
      expect(html).toContain("Old Show");
      expect(html).toContain("<details><summary>Multi-booking link</summary>");
      expect(html).toContain(
        '<a href="/admin/log">Log</a> &middot; <a href="/admin/guide">Guide</a>',
      );
      expect(html).toContain(
        '<p class="guide-footer"><a class="guide-link" href="/admin/guide#listings">',
      );
      expect(html).toContain("<span>Listings guide</span>");
      expect(html).toContain('<footer class="admin-footer">');
    });
  });

  test("renders the editor variant: money-free table, sections, no CSV or guide", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage(populated, EDITOR_SESSION);

      expect(html).toContain('<a class="active" href="/admin/listings">');
      expect(html).toContain("<th>Listing name</th>");
      expect(html).not.toContain("<th>Revenue</th>");
      expect(html).not.toContain('href="/admin/listings/csv"');
      expect(html).toContain("<h2>Deactivated</h2>");
      expect(html).toContain("<details><summary>Multi-booking link</summary>");
      expect(html).not.toContain('href="/admin/guide#listings"');
      expect(html).toContain('<footer class="admin-footer">');
      expect(html).toContain('<a href="/admin/logout">Log out</a>');
    });
  });

  test("renders the complete owner empty state with the CSV export", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage([], OWNER_SESSION);

      expect(html).toContain("<title>Listings</title>");
      expect(html).toContain('<a class="active" href="/admin/listings">');
      expect(html).toContain("No listings yet");
      expect(html).toContain('<a href="/admin/listings/csv">Export CSV</a>');
      expect(html).not.toContain("<h2>Deactivated</h2>");
      expect(html).not.toContain("multi-booking-list");
      expect(html).toContain(
        '<p class="guide-footer"><a class="guide-link" href="/admin/guide#listings">',
      );
      expect(html).toContain("<span>Listings guide</span>");
      expect(html).toContain('<footer class="admin-footer">');
    });
  });

  test("renders the editor empty page without the staff-only links", async () => {
    await withRequestContext(() => {
      const html = adminListingsPage([], EDITOR_SESSION);

      expect(html).toContain("No listings yet");
      expect(html).not.toContain('href="/admin/listings/csv"');
      expect(html).not.toContain('href="/admin/guide#listings"');
      expect(html).toContain('<footer class="admin-footer">');
    });
  });
});
