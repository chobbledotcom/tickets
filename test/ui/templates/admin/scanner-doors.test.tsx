import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { AdminNav } from "#templates/admin/nav.tsx";
import { adminScannerDoorsPage } from "#templates/admin/scanner.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("the admin scanner doors page template", () => {
  beforeAll(setupAdminPageTest);

  /** The doors page serves a scanner login, whose nav carries no other
   *  section's words for the assertions below to trip over. */
  const SCANNER_SESSION = { adminLevel: "scanner" as const };

  test("lists every door under its kind, as a link to the door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [{ name: "Ceilidh", path: "/admin/listings/3/scan" }],
    });

    expect(html).toContain("<title>Scanner doors</title>");
    expect(html).toContain(t("admin.scanner.doors_intro"));
    expect(html).toContain(t("terms.listings"));
    expect(html).toContain(t("terms.groups"));
    expect(html).toContain('href="/admin/listings/3/scan">Ceilidh</a>');
    expect(html).toContain('href="/admin/groups/7/scan">Winter Social</a>');
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

    expect(html).toContain(t("terms.listings"));
    expect(html).toContain('href="/admin/listings/3/scan">Ceilidh</a>');
    // An empty heading would promise a link that is not there.
    expect(html).not.toContain(t("terms.groups"));
  });

  test("lists the group doors alone when no listing has a door", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [{ name: "Winter Social", path: "/admin/groups/7/scan" }],
      listingDoors: [],
    });

    expect(html).toContain(t("terms.groups"));
    expect(html).toContain('href="/admin/groups/7/scan">Winter Social</a>');
    expect(html).not.toContain(t("terms.listings"));
  });

  test("says when there are no doors yet", () => {
    const html = adminScannerDoorsPage(SCANNER_SESSION, {
      groupDoors: [],
      listingDoors: [],
    });

    expect(html).toContain(t("admin.scanner.doors_empty"));
    expect(html).not.toContain(t("terms.listings"));
    expect(html).not.toContain(t("terms.groups"));
    // A door's path always ends in "/scan"; the empty doors page links to no
    // door (the nav's own /admin/scanner route is not a door).
    expect(html).not.toContain('href="/admin/listing/');
    expect(html).not.toContain('href="/admin/groups/');
  });

  test("the nav links a scanner back to the doors list", () => {
    // A scanner who opens a door from a bookmark still needs the route back
    // to /admin/scanner to pick another door: the role's only nav destination.
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "scanner" } }),
    );
    expect(html).toContain('href="/admin/scanner"');
    expect(html).toContain(">Scanner</a>");
  });

  test("the nav offers the doors list to a scanner login only", () => {
    // Staff reach every door from its listing or group page, so the nav keeps
    // the link for the one role whose whole job it is.
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html).not.toContain('href="/admin/scanner"');
    }
  });
});
