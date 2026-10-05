/**
 * The listings index's group filter bar: one entry per stored group, the
 * chosen group marked, and the export link carrying the chosen scope.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminListingsPage } from "#templates/admin/dashboard.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("the listings page group bar", () => {
  beforeAll(setupAdminPageTest);

  test("renders one entry per stored group", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
      undefined,
      undefined,
      undefined,
      {
        activeGroupId: null,
        groups: [
          { id: 3, name: "Autumn fair" },
          { id: 5, name: "Weekend" },
        ],
      },
    );
    expect(html).toContain("Group: <strong><u>All groups</u></strong>");
    expect(html).toContain('href="/admin/listings?group=3">Autumn fair</a>');
    expect(html).toContain('href="/admin/listings?group=5">Weekend</a>');
    // The export link carries the chosen scope so a filtered page exports
    // what it shows.
    expect(html).toContain('href="/admin/listings/csv"');
  });

  test("marks the chosen group and points the CSV export at it", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
      undefined,
      undefined,
      undefined,
      { activeGroupId: 3, groups: [{ id: 3, name: "Autumn fair" }] },
    );
    expect(html).toContain('<a href="/admin/listings">All groups</a>');
    expect(html).toContain("<strong><u>Autumn fair</u></strong>");
    expect(html).toContain('href="/admin/listings/csv?group=3"');
  });

  test("renders no group bar when the site stores no groups", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    expect(html).not.toContain("All groups");
  });
});
