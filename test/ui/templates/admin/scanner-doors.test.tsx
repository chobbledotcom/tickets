import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { AdminNav } from "#templates/admin/nav.tsx";
import { adminScannerDoorsPage } from "#templates/admin/scanner.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import type { AdminSession } from "#types";

describe("the admin scanner doors page template", () => {
  beforeAll(setupAdminPageTest);

  /** The doors page serves a scanner login, whose nav carries no other
   *  section's words for the assertions below to trip over. */
  const SCANNER_SESSION: AdminSession = { adminLevel: "scanner" };

  test("lists every door under its kind, as a link to the door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [{ name: "Ceilidh", path: "/admin/listings/3/scan" }],
    });

    assertStringIncludes(html, "<title>Scanner doors</title>");
    assertStringIncludes(html, t("admin.scanner.doors_intro"));
    assertStringIncludes(html, t("terms.listings"));
    assertStringIncludes(html, t("terms.groups"));
    assertStringIncludes(html, 'href="/admin/listings/3/scan">Ceilidh</a>');
    assertStringIncludes(html, 'href="/admin/groups/7/scan">Winter Social</a>');
    // The listings section is announced before the groups section.
    expect(html.indexOf(t("terms.listings"))).toBeLessThan(
      html.indexOf(t("terms.groups")),
    );
  });

  test("leaves out the kind of door that has none", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [{ name: "Ceilidh", path: "/admin/listings/3/scan" }],
    });

    assertStringIncludes(html, t("terms.listings"));
    assertStringIncludes(html, 'href="/admin/listings/3/scan">Ceilidh</a>');
    // An empty heading would promise a link that is not there.
    assert(!html.includes(t("terms.groups")));
  });

  test("lists the group doors alone when no listing has a door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [],
    });

    assertStringIncludes(html, t("terms.groups"));
    assertStringIncludes(html, 'href="/admin/groups/7/scan">Winter Social</a>');
    assert(!html.includes(t("terms.listings")));
  });

  test("says when there are no doors yet", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [],
    });

    assertStringIncludes(html, t("admin.scanner.doors_empty"));
    assert(!html.includes(t("terms.listings")));
    assert(!html.includes(t("terms.groups")));
    // A door's path always ends in "/scan"; the empty doors page links to no
    // door (the nav's own /admin/scanner route is not a door).
    assert(!html.includes('href="/admin/listing/'));
    assert(!html.includes('href="/admin/groups/'));
  });

  test("the nav links a scanner back to the doors list", () => {
    // A scanner who opens a door from a bookmark still needs the route back
    // to /admin/scanner to pick another door: the role's only nav destination.
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "scanner" } }),
    );
    assertStringIncludes(html, 'href="/admin/scanner"');
    assertStringIncludes(html, ">Scanner</a>");
  });

  test("the nav offers the doors list to a scanner login only", () => {
    // Staff reach every door from its listing or group page, so the nav keeps
    // the link for the one role whose whole job it is.
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      assert(!html.includes('href="/admin/scanner"'));
    }
  });
});
