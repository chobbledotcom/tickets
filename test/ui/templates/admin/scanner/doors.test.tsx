import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { adminScannerDoorsPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

describe("the scanner doors page template", () => {
  beforeAll(setupAdminPageTest);

  test("lists the group and listing doors a scanner can open", () => {
    const html = adminScannerDoorsPage(OWNER_SESSION, {
      groupDoors: [{ name: "Camping", path: "/admin/groups/5/scanner" }],
      listingDoors: [{ name: "Main Gate", path: "/admin/listing/3/scanner" }],
    });

    assertStringIncludes(html, t("admin.scanner.doors_title"));
    assertStringIncludes(html, t("admin.scanner.doors_heading"));
    assertStringIncludes(html, t("admin.scanner.doors_intro"));
    // Each kind gets its own heading, and each door its own link.
    assertStringIncludes(html, t("terms.listings"));
    assertStringIncludes(html, t("terms.groups"));
    assertStringIncludes(html, 'href="/admin/listing/3/scanner"');
    assertStringIncludes(html, 'href="/admin/groups/5/scanner"');
    assertStringIncludes(html, "Main Gate");
    assertStringIncludes(html, "Camping");
    assert(!html.includes(t("admin.scanner.doors_empty")));
  });

  test("lists a lone listing door when no group door exists", () => {
    // Only one kind of door exists, so the empty check must not mistake a
    // present door of the other kind for an empty page.
    const html = adminScannerDoorsPage(OWNER_SESSION, {
      groupDoors: [],
      listingDoors: [{ name: "Main Gate", path: "/admin/listing/3/scanner" }],
    });

    assertStringIncludes(html, 'href="/admin/listing/3/scanner"');
    assertStringIncludes(html, "Main Gate");
    assert(!html.includes(t("admin.scanner.doors_empty")));
  });

  test("says there is no door to scan when every door is closed", () => {
    const html = adminScannerDoorsPage(OWNER_SESSION, {
      groupDoors: [],
      listingDoors: [],
    });

    assertStringIncludes(html, t("admin.scanner.doors_empty"));
    // Neither kind of door link appears on the empty page.
    assert(!html.includes('href="/admin/listing/'));
    assert(!html.includes('href="/admin/groups/'));
  });
});
