/** Tests for the group Edit panel: the form fields an existing group's own
 * page draws — its package member prices, and its stored yes/no boxes. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { GroupEditPanel } from "#templates/admin/groups/form.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";

describe("GroupEditPanel package members table", () => {
  beforeAll(setupAdminPageTest);

  test("renders saved overrides and falls back to defaults for members without a row", () => {
    const group = testGroup({ is_package: true, name: "Bundle" });
    const withOverride = testListingWithCount({ id: 1, name: "Priced" });
    const withoutRow = testListingWithCount({ id: 2, name: "Default" });
    // Only listing 1 has a saved member row; listing 2 exercises the
    // member-absent defaults (price → blank, quantity → 1).
    const members = new Map([[1, { price: 1500, quantity: 4 }]]);

    const html = String(
      GroupEditPanel({
        group,
        listings: [withOverride, withoutRow],
        members,
      }),
    );
    assertStringIncludes(html, 'name="package_price_1"');
    assertStringIncludes(html, 'value="15.00"');
    assertStringIncludes(html, 'name="package_qty_1"');
    assertStringIncludes(html, 'value="4"');
    // Listing 2 (no row): blank price, quantity defaults to 1.
    expect(html).toMatch(
      /<input(?=[^>]*name="package_price_2")(?=[^>]*value="")[^>]*>/,
    );
  });

  test("renders the group's stored yes/no boxes as they stand", () => {
    // Regression: the stored door rule was once drawn clear however it
    // stood, so an operator could never see — nor keep — a stored yes.
    const opening = testGroup({
      name: "Festival",
      scan_checks_in_all_listings: true,
    });
    const html = String(
      GroupEditPanel({ group: opening, listings: [], members: new Map() }),
    );
    assertStringIncludes(
      html.match(
        /<input type="checkbox" name="scan_checks_in_all_listings"[^>]*>/,
      )![0],
      " checked",
    );

    const closed = testGroup({
      name: "Festival",
      scan_checks_in_all_listings: false,
    });
    const closedHtml = String(
      GroupEditPanel({ group: closed, listings: [], members: new Map() }),
    );
    assert(
      !closedHtml
        .match(
          /<input type="checkbox" name="scan_checks_in_all_listings"[^>]*>/,
        )![0]
        .includes(" checked"),
      "the value should not contain the searched item",
    );
  });

  test("shows the empty-state prompt when the package has no listings", () => {
    const group = testGroup({ is_package: true, name: "Empty" });
    const html = String(
      GroupEditPanel({ group, listings: [], members: new Map() }),
    );
    assertStringIncludes(html, "Add listings to this group");
  });

  test("leaves the JSON export on the Actions tab", () => {
    const group = testGroup({ id: 7, name: "Exportable" });
    const html = String(
      GroupEditPanel({ group, listings: [], members: new Map() }),
    );
    // The Actions panel owns the export link; the Edit panel omits it.
    assert(
      !html.includes(`/admin/groups/${group.id}/export.json`),
      "the value should not contain the searched item",
    );
  });
});
