import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panels.tsx";
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
      assertStringIncludes(html, "Read-only from");
      assertStringIncludes(html, "in");
      assertStringIncludes(html, "day");
    });

    test("shows the build count above the list, singular for 1", () => {
      const one = adminBuiltSitesPage([testBuiltSite()], OWNER_SESSION);
      assertStringIncludes(one, "1 build");
      const two = adminBuiltSitesPage(
        [testBuiltSite(), testBuiltSite({ id: 2 })],
        OWNER_SESSION,
      );
      assertStringIncludes(two, "2 builds");
      // The count names the number before the list itself starts.
      expect(two.indexOf("2 builds")).toBeLessThan(two.indexOf("<table"));
    });

    test("links each sortable header and marks the sort in force", () => {
      const html = adminBuiltSitesPage([testBuiltSite()], OWNER_SESSION);
      // Name is the default sort, so its heading is plain text and the
      // others link to their sort.
      assertStringIncludes(html, "<strong>Name</strong>");
      assertStringIncludes(html, 'href="/admin/built-sites?sort=created"');
      assertStringIncludes(
        html,
        'href="/admin/built-sites?sort=read_only_from"',
      );
      const byCreated = adminBuiltSitesPage(
        [testBuiltSite()],
        OWNER_SESSION,
        undefined,
        [],
        "created",
      );
      assertStringIncludes(byCreated, "<strong>Created</strong>");
      assertStringIncludes(byCreated, 'href="/admin/built-sites?sort=name"');
    });

    test("renders the created column as a short datetime", () => {
      const html = adminBuiltSitesPage([testBuiltSite()], OWNER_SESSION);
      assertStringIncludes(html, "Created");
      assertStringIncludes(html, "<td>2026-01-01 00:00</td>");
    });

    test("renders 'never' for empty deadline", () => {
      const site = testBuiltSite({ readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      assertStringIncludes(html, "never");
    });

    test("links each site name to its entity page and has no list delete link", () => {
      const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      assertStringIncludes(html, 'href="/admin/built-sites/7">Linky</a>');
      assert(!html.includes("/admin/built-sites/7/delete"));
    });

    test("warns when no qualifying renewal tier is configured", () => {
      const site = testBuiltSite({ readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION, undefined, []);
      assertStringIncludes(html, "Renewal tiers");
      assertStringIncludes(html, "No renewal tier listing is configured");
      assertStringIncludes(html, "won't be able to renew");
    });

    test("keeps the read-only entity link but hides create actions", () => {
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
      const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
      const html = adminBuiltSitesPage([site], OWNER_SESSION);
      assertStringIncludes(html, "Linky");
      assert(!html.includes('href="/admin/built-sites/new"'));
      assertStringIncludes(html, 'href="/admin/built-sites/7"');
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
      assertStringIncludes(html, "bunny-1");
      assert(!html.includes("deno-1</p>"));
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
      assertStringIncludes(html, "Monthly tier");
      assertStringIncludes(html, "Annual tier");
      assertStringIncludes(html, ">7<");
      assertStringIncludes(html, ">2<");
      assertStringIncludes(html, 'href="/admin/listing/11"');
      assertStringIncludes(html, 'href="/admin/listing/12"');
      assert(!html.includes("No renewal tier listing is configured"));
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
      assertStringIncludes(newPage, 'action="/admin/built-sites"');
      assertStringIncludes(newPage, "Add Built Site");
      const edit = String(BuiltSiteEditPanel({ site }));
      assertStringIncludes(edit, 'action="/admin/built-sites/42/edit"');
      assertStringIncludes(edit, "Save Changes");
      const deletePage = adminBuiltSiteDeletePage(site, OWNER_SESSION);
      assertStringIncludes(deletePage, 'action="/admin/built-sites/42/delete"');
      assertStringIncludes(deletePage, "Delete Built Site");
      assertStringIncludes(deletePage, "Delete &lt;site&gt;");
      assert(!deletePage.includes("button-danger"));
    });

    test("adds a (visit) link with the rewritten host inside the Site URL label", () => {
      const site = testBuiltSite({ siteUrl: "https://test.bunny.net/tickets" });
      const edit = String(BuiltSiteEditPanel({ site }));
      assertStringIncludes(
        edit,
        '<label>Site URL <a href="https://test.b-cdn.net/tickets" target="_blank" rel="noopener noreferrer">(visit)</a>',
      );
    });

    test("links a bare saved hostname as an absolute address", () => {
      const site = testBuiltSite({ siteUrl: "test-42.b-cdn.net" });
      const edit = String(BuiltSiteEditPanel({ site }));
      assertStringIncludes(
        edit,
        'href="https://test-42.b-cdn.net" target="_blank" rel="noopener noreferrer"',
      );
    });

    test("rewrites a bare zone hostname and keeps the link absolute", () => {
      const site = testBuiltSite({ siteUrl: "x.bunny.net" });
      const edit = String(BuiltSiteEditPanel({ site }));
      assertStringIncludes(edit, 'href="https://x.b-cdn.net"');
    });

    test("adds no (visit) link when no site URL is saved", () => {
      const site = testBuiltSite({ siteUrl: "" });
      const edit = String(BuiltSiteEditPanel({ site }));
      assert(!edit.includes("(visit)"));
    });

    test("renders the edit form, with no (visit) link, for a malformed saved URL", () => {
      const site = testBuiltSite({ siteUrl: "https://" });
      const edit = String(BuiltSiteEditPanel({ site }));
      assertStringIncludes(edit, 'action="/admin/built-sites');
      assertStringIncludes(edit, 'value="https://"');
      assert(!edit.includes("(visit)"));
    });
  });

  describe("renewalPanelFor — provisioned site", () => {
    const provisionedSite = testBuiltSite({
      readOnlyFrom: "2027-01-15T00:00:00Z",
      renewalToken: "real-customer-renewal-token",
      renewalTokenIndex: "some-index",
    });

    test("shows renewal URL and rotate/bump/override/re-sync forms; no tier picker", () => {
      const html = String(renewalPanelFor(provisionedSite));
      assertStringIncludes(html, "Renewal URL");
      assertStringIncludes(html, "rotate-renewal-token");
      assertStringIncludes(html, "bump-deadline");
      assertStringIncludes(html, "override-deadline");
      assertStringIncludes(html, "re-sync-deadline");
      assertStringIncludes(html, "Rotate token");
      assertStringIncludes(html, "Re-sync deadline");
      assert(!html.includes("tier_listing_id"));
      assert(!html.includes("set-renewal-tier"));
    });

    test("renders the actual renewal URL (token, not placeholder)", () => {
      const html = String(renewalPanelFor(provisionedSite));
      assertStringIncludes(html, "/renew/?t=real-customer-renewal-token");
      assert(!html.includes("?t=<token>"));
    });

    test("labels the shared bump/override forms inline (no headings)", () => {
      const html = String(renewalPanelFor(provisionedSite));
      assertStringIncludes(
        html,
        '<label for="bump_months">Bump deadline by months',
      );
      assertStringIncludes(
        html,
        '<label for="override_date">Override deadline',
      );
      assert(!html.includes("<h3>Bump deadline</h3>"));
    });
  });

  describe("renewalPanelFor — unprovisioned site", () => {
    const unprovisionedSite = testBuiltSite({
      readOnlyFrom: "",
      renewalTokenIndex: null,
    });

    test("shows Provision Renewal form, bump/override forms; no Rotate/Re-sync; no tier picker", () => {
      const html = String(renewalPanelFor(unprovisionedSite));
      assertStringIncludes(html, "Provision renewal");
      assertStringIncludes(html, "provision-renewal");
      assertStringIncludes(html, "bump-deadline");
      assertStringIncludes(html, "override-deadline");
      assert(!html.includes("rotate-renewal-token"));
      assert(!html.includes("re-sync-deadline"));
      assert(!html.includes("tier_listing_id"));
    });

    test("labels the shared bump/override forms with headings (no inline labels)", () => {
      const html = String(renewalPanelFor(unprovisionedSite));
      assertStringIncludes(html, "<h3>Bump deadline</h3>");
      assertStringIncludes(html, "<h3>Override deadline</h3>");
      assert(!html.includes('for="bump_months"'));
      assert(!html.includes('for="override_date"'));
    });
  });

  describe("SecretsPanel", () => {
    const site = testBuiltSite({ id: 9, name: "Sec" });

    test("lists the missing secrets with a backfill button", () => {
      const html = String(
        SecretsPanel({
          site,
          view: {
            expected: ["DB_URL", "NTFY_URL", "STORAGE_ZONE_KEY"],
            missing: ["NTFY_URL", "STORAGE_ZONE_KEY"],
            ok: true,
            pairConflicts: [],
            present: ["DB_URL", "DB_ENCRYPTION_KEY"],
          },
        }),
      );
      assertStringIncludes(html, "/admin/built-sites/9/add-secrets");
      assertStringIncludes(html, "<code>NTFY_URL</code>");
      assertStringIncludes(html, "<code>STORAGE_ZONE_KEY</code>");
      assertStringIncludes(html, "Set 2 missing secret(s)");
      assertStringIncludes(html, "host-level infrastructure credentials");
      assertStringIncludes(html, "STORAGE_ZONE_KEY");
      assertStringIncludes(html, "Secrets currently on this site");
      assertStringIncludes(html, "<code>DB_ENCRYPTION_KEY</code>");
    });

    test("omits the live-secrets list when the site has none set", () => {
      const html = String(
        SecretsPanel({
          site,
          view: {
            expected: ["NTFY_URL"],
            missing: ["NTFY_URL"],
            ok: true,
            pairConflicts: [],
            present: [],
          },
        }),
      );
      assert(!html.includes("Secrets currently on this site"));
      assertStringIncludes(html, "/admin/built-sites/9/add-secrets");
      assert(!html.includes("host-level infrastructure credentials"));
    });

    test("confirms when every expected secret is already present", () => {
      const html = String(
        SecretsPanel({
          site,
          view: {
            expected: ["DB_URL", "NTFY_URL"],
            missing: [],
            ok: true,
            pairConflicts: [],
            present: ["DB_URL", "NTFY_URL"],
          },
        }),
      );
      assertStringIncludes(html, "All expected secrets are present");
      assert(!html.includes("add-secrets"));
    });

    test("shows the error when secrets cannot be read", () => {
      const html = String(
        SecretsPanel({
          site,
          view: {
            error:
              "BUNNY_API_KEY is not configured on this host, so its secrets can't be read.",
            ok: false,
          },
        }),
      );
      assertStringIncludes(html, "BUNNY_API_KEY is not configured");
      assert(!html.includes("add-secrets"));
    });

    test("notes when the secrets view is unavailable", () => {
      const html = String(SecretsPanel({ site }));
      assertStringIncludes(html, "Secrets status is unavailable");
    });
  });

  describe("UpdatePanel", () => {
    const site = testBuiltSite({ id: 42, name: "Panel Site" });
    const baseState = {
      hasHostingId: true,
      latestVersion: "v2099-01-01-120000",
      latestVersionName: "2099-01-01 - Big Update",
      providerConfigured: true,
      siteVersionError: null as string | null,
      siteVersionLabel: "Thu, 01 Jan 2026 00:00:00 UTC" as string | null,
      updateAvailable: true,
      upToDate: false,
    };
    const render = (overrides: Partial<typeof baseState> = {}): string =>
      String(UpdatePanel({ site, state: { ...baseState, ...overrides } }));

    test("shows the version, latest release, and an update button when behind", () => {
      const html = render();
      assertStringIncludes(html, "Thu, 01 Jan 2026 00:00:00 UTC");
      assertStringIncludes(
        html,
        "2099-01-01 - Big Update (v2099-01-01-120000)",
      );
      assertStringIncludes(html, "An update is available");
      assertStringIncludes(html, "/admin/built-sites/42/update");
      assertStringIncludes(html, "Update this site");
    });

    test("shows up to date when the site is on the latest release", () => {
      const html = render({ updateAvailable: false, upToDate: true });
      assertStringIncludes(html, "on the latest known release");
    });

    test("shows unknown when no database keys are stored", () => {
      const html = render({ siteVersionLabel: null, updateAvailable: false });
      assertStringIncludes(html, "no read-only database credentials");
    });

    test("shows the read error when the site database is unreachable", () => {
      const html = render({
        siteVersionError: "connection refused",
        siteVersionLabel: null,
        updateAvailable: false,
      });
      assertStringIncludes(html, "connection refused");
    });

    test("notes when the host has not checked for a release yet", () => {
      const html = render({ latestVersion: "", updateAvailable: false });
      assertStringIncludes(html, "None checked yet");
    });

    test("explains when automatic update is unavailable", () => {
      const html = render({
        providerConfigured: false,
        updateAvailable: false,
        upToDate: false,
      });
      assertStringIncludes(html, "Automatic update needs the provider API key");
      assert(!html.includes("Update this site"));
    });
  });
});
