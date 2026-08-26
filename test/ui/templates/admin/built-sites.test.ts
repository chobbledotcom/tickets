import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
  BuiltSiteEditPanel,
  builtSiteToFieldValues,
} from "#templates/admin/built-sites.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite, testListingWithCount } from "#test-utils/factories.ts";

describe("built-site templates", () => {
  beforeAll(setupAdminPageTest);

  describe("adminBuiltSitesPage", () => {
    test("renders formatted deadline column", () => {
      const site = testBuiltSite({ readOnlyFrom: "2099-06-01T00:00:00Z" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      expect(html).toContain("Read-only from");
      expect(html).toContain("in");
      expect(html).toContain("day");
    });

    test("renders 'never' for empty deadline", () => {
      const site = testBuiltSite({ readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      expect(html).toContain("never");
    });

    test("links each site name to its entity page and has no list delete link", () => {
      const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      expect(html).toContain('href="/admin/built-sites/7">Linky</a>');
      expect(html).not.toContain("/admin/built-sites/7/delete");
    });

    test("warns when no qualifying renewal tier is configured", () => {
      const site = testBuiltSite({ readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION, undefined, []);
      expect(html).toContain("Renewal tiers");
      expect(html).toContain("No renewal tier listing is configured");
      expect(html).toContain("won't be able to renew");
    });

    test("keeps the read-only entity link but hides create actions", () => {
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
      const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      expect(html).toContain("Linky");
      expect(html).not.toContain('href="/admin/built-sites/new"');
      expect(html).toContain('href="/admin/built-sites/7"');
    });

    test("lists only Bunny hosting ids in the shared host marker", () => {
      const html = adminBuiltSitesPage(
        [
          testBuiltSite({ hostingId: "bunny-1", hostingProvider: "bunny" }),
          testBuiltSite({ hostingId: "deno-1", hostingProvider: "deno" }),
          testBuiltSite({ hostingId: "", hostingProvider: "bunny" }),
        ],
        OWNER_SESSION,
      );
      expect(html).toContain("bunny-1");
      expect(html).not.toContain("deno-1</p>");
    });

    test("names each site's renewal tier and links the tier listing", () => {
      const monthly = testListingWithCount({ id: 11, name: "Monthly tier" });
      const html = adminBuiltSitesPage(
        [
          testBuiltSite({ id: 1, name: "Pinned", renewalTierListingId: 11 }),
          testBuiltSite({ id: 2, name: "Open", renewalTierListingId: null }),
          testBuiltSite({ id: 3, name: "Gone", renewalTierListingId: 99 }),
        ],
        OWNER_SESSION,
        undefined,
        [monthly],
      );
      expect(html).toContain("Renewal tier");
      expect(html).toContain('<td><a href="/admin/listing/11">Monthly tier</a>');
      expect(html).toContain("<td>Any</td>");
      expect(html).toContain("<td>Tier removed</td>");
    });

    test("lists each tier with units sold from attendee_count", () => {
      const monthly = testListingWithCount({
        attendee_count: 7,
        hidden: true,
        id: 11,
        months_per_unit: 1,
        name: "Monthly tier",
        purchase_only: true,
        unit_price: 500,
      });
      const annual = testListingWithCount({
        attendee_count: 2,
        hidden: true,
        id: 12,
        months_per_unit: 12,
        name: "Annual tier",
        purchase_only: true,
        unit_price: 5000,
      });
      const site = testBuiltSite({ readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION, undefined, [
        monthly,
        annual,
      ]);
      expect(html).toContain("Monthly tier");
      expect(html).toContain("Annual tier");
      expect(html).toContain(">7<");
      expect(html).toContain(">2<");
      expect(html).toContain('href="/admin/listing/11"');
      expect(html).toContain('href="/admin/listing/12"');
      expect(html).not.toContain("No renewal tier listing is configured");
    });
  });

  describe("built-site forms", () => {
    test("maps exact empty and populated field values", () => {
      expect(builtSiteToFieldValues()).toEqual({
        assignable: "",
        db_provider: "bunny",
        db_token: "",
        db_url: "",
        hosting_id: "",
        hosting_provider: "bunny",
        name: "",
        site_url: "",
        updates: "release",
      });
      expect(
        builtSiteToFieldValues(
          testBuiltSite({
            assignable: true,
            dbProvider: "turso",
            dbToken: "token",
            dbUrl: "libsql://site",
            hostingId: "app-1",
            hostingProvider: "deno",
            name: "Site",
            siteUrl: "site.example",
            updates: "alpha",
          }),
        ),
      ).toEqual({
        assignable: "1",
        db_provider: "turso",
        db_token: "token",
        db_url: "libsql://site",
        hosting_id: "app-1",
        hosting_provider: "deno",
        name: "Site",
        site_url: "site.example",
        updates: "alpha",
      });
    });

    test("renders new, edit, and delete destinations and labels", () => {
      const site = testBuiltSite({ id: 42, name: "Delete <site>" });
      const newPage = adminBuiltSiteNewPage(OWNER_SESSION);
      expect(newPage).toContain('action="/admin/built-sites"');
      expect(newPage).toContain("Add Built Site");
      const edit = String(BuiltSiteEditPanel({ site }));
      expect(edit).toContain('action="/admin/built-sites/42/edit"');
      expect(edit).toContain("Save Changes");
      const deletePage = adminBuiltSiteDeletePage(site, OWNER_SESSION);
      expect(deletePage).toContain('action="/admin/built-sites/42/delete"');
      expect(deletePage).toContain("Delete Built Site");
      expect(deletePage).toContain("Delete &lt;site&gt;");
      expect(deletePage).not.toContain("button-danger");
    });
  });

});
