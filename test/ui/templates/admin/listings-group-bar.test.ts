/**
 * The listings index's group filter bar: one entry per stored group, the
 * chosen group marked, and the export link carrying the chosen scope.
 */

import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminListingsPage } from "#templates/admin/dashboard.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

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
    says(html, "Group: <strong><u>All groups</u></strong>");
    says(html, 'href="/admin/listings?group=3">Autumn fair</a>');
    says(html, 'href="/admin/listings?group=5">Weekend</a>');
    // The export link carries the chosen scope so a filtered page exports
    // what it shows.
    says(html, 'href="/admin/listings/csv"');
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
    says(html, '<a href="/admin/listings">All groups</a>');
    says(html, "<strong><u>Autumn fair</u></strong>");
    says(html, 'href="/admin/listings/csv?group=3"');
  });

  test("renders no group bar when the site stores no groups", () => {
    const html = adminListingsPage(
      [testListingWithCount({ name: "Active Show" })],
      OWNER_SESSION,
    );
    assert(!html.includes("All groups"));
  });
});
