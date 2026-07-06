import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminBuiltSiteEditPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import {
  setupTestEncryptionKey,
  testBuiltSite,
  testListingWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminBuiltSitesPage", () => {
  test("renders formatted deadline column", () => {
    const site = testBuiltSite({ readOnlyFrom: "2099-06-01T00:00:00Z" });
    const html = adminBuiltSitesPage([site], TEST_SESSION);
    expect(html).toContain("Read-only from");
    expect(html).toContain("in");
    expect(html).toContain("day");
  });

  test("renders 'never' for empty deadline", () => {
    const site = testBuiltSite({ readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION);
    expect(html).toContain("never");
  });

  test("links each site name to its edit page and has no list delete link", () => {
    const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION);
    expect(html).toContain('href="/admin/built-sites/7/edit">Linky</a>');
    // Delete now lives on the edit page, not the list.
    expect(html).not.toContain("/admin/built-sites/7/delete");
  });

  test("warns when no qualifying renewal tier is configured", () => {
    const site = testBuiltSite({ readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION, undefined, []);
    expect(html).toContain("Renewal tiers");
    expect(html).toContain("No renewal tier listing is configured");
    expect(html).toContain("won't be able to renew");
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
    const html = adminBuiltSitesPage([site], TEST_SESSION, undefined, [
      monthly,
      annual,
    ]);
    expect(html).toContain("Monthly tier");
    expect(html).toContain("Annual tier");
    // Units sold = attendee_count
    expect(html).toContain(">7<");
    expect(html).toContain(">2<");
    // Linked back to the listing detail page
    expect(html).toContain('href="/admin/listing/11"');
    expect(html).toContain('href="/admin/listing/12"');
    // Warning copy must not appear when tiers exist
    expect(html).not.toContain("No renewal tier listing is configured");
  });
});

describe("adminBuiltSiteEditPage — provisioned site", () => {
  const provisionedSite = testBuiltSite({
    readOnlyFrom: "2027-01-15T00:00:00Z",
    renewalToken: "real-customer-renewal-token",
    renewalTokenIndex: "some-index",
  });

  test("shows renewal URL and rotate/bump/override/re-sync forms; no tier picker", () => {
    const html = adminBuiltSiteEditPage(provisionedSite, TEST_SESSION);
    expect(html).toContain("Renewal URL");
    expect(html).toContain("rotate-renewal-token");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).toContain("re-sync-deadline");
    expect(html).toContain("Rotate token");
    expect(html).toContain("Re-sync deadline");
    expect(html).not.toContain("tier_listing_id");
    expect(html).not.toContain("set-renewal-tier");
  });

  test("renders the actual renewal URL (token, not placeholder)", () => {
    const html = adminBuiltSiteEditPage(provisionedSite, TEST_SESSION);
    // The real token must appear inside a /renew/?t=… URL. The previous
    // implementation rendered "<token>" literally with a bogus host — guard
    // against regression by asserting both the path shape and the token.
    expect(html).toContain("/renew/?t=real-customer-renewal-token");
    expect(html).not.toContain("?t=<token>");
  });

  test("labels the shared bump/override forms inline (no headings)", () => {
    const html = adminBuiltSiteEditPage(provisionedSite, TEST_SESSION);
    expect(html).toContain('<label for="bump_months">Bump deadline by months');
    expect(html).toContain('<label for="override_date">Override deadline');
    expect(html).not.toContain("<h3>Bump deadline</h3>");
  });
});

describe("adminBuiltSiteEditPage — unprovisioned site", () => {
  const unprovisionedSite = testBuiltSite({
    readOnlyFrom: "",
    renewalTokenIndex: null,
  });

  test("shows Provision Renewal form, bump/override forms; no Rotate/Re-sync; no tier picker", () => {
    const html = adminBuiltSiteEditPage(unprovisionedSite, TEST_SESSION);
    expect(html).toContain("Provision renewal");
    expect(html).toContain("provision-renewal");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).not.toContain("rotate-renewal-token");
    expect(html).not.toContain("re-sync-deadline");
    expect(html).not.toContain("tier_listing_id");
  });

  test("labels the shared bump/override forms with headings (no inline labels)", () => {
    const html = adminBuiltSiteEditPage(unprovisionedSite, TEST_SESSION);
    expect(html).toContain("<h3>Bump deadline</h3>");
    expect(html).toContain("<h3>Override deadline</h3>");
    expect(html).not.toContain('for="bump_months"');
    expect(html).not.toContain('for="override_date"');
  });

  test("links to the delete page from the edit page", () => {
    const html = adminBuiltSiteEditPage(
      testBuiltSite({ id: 9, name: "Del" }),
      TEST_SESSION,
    );
    expect(html).toContain("/admin/built-sites/9/delete");
    expect(html).toContain("Delete this site");
  });
});

describe("adminBuiltSiteEditPage — secrets panel", () => {
  const site = testBuiltSite({ id: 9, name: "Sec" });

  test("lists the missing secrets with a backfill button", () => {
    const html = adminBuiltSiteEditPage(
      site,
      TEST_SESSION,
      undefined,
      undefined,
      {
        expected: ["DB_URL", "NTFY_URL", "STORAGE_ZONE_KEY"],
        missing: ["NTFY_URL", "STORAGE_ZONE_KEY"],
        ok: true,
        present: ["DB_URL", "DB_ENCRYPTION_KEY"],
      },
    );
    expect(html).toContain("Secrets");
    expect(html).toContain("/admin/built-sites/9/add-secrets");
    expect(html).toContain("<code>NTFY_URL</code>");
    expect(html).toContain("<code>STORAGE_ZONE_KEY</code>");
    expect(html).toContain("Set 2 missing secret(s)");
    // STORAGE_ZONE_KEY is host-level infrastructure, so the heads-up note names
    // it so the operator knows backfilling grants the child host-level access.
    expect(html).toContain("host-level infrastructure credentials");
    expect(html).toContain("STORAGE_ZONE_KEY");
    // Live secrets are listed for insight, including ones outside the copy set.
    expect(html).toContain("Secrets currently on this site");
    expect(html).toContain("<code>DB_ENCRYPTION_KEY</code>");
  });

  test("omits the live-secrets list when the site has none set", () => {
    const html = adminBuiltSiteEditPage(
      site,
      TEST_SESSION,
      undefined,
      undefined,
      {
        expected: ["NTFY_URL"],
        missing: ["NTFY_URL"],
        ok: true,
        present: [],
      },
    );
    expect(html).not.toContain("Secrets currently on this site");
    expect(html).toContain("/admin/built-sites/9/add-secrets");
    // NTFY_URL is not host-level infrastructure, so the heads-up note is absent.
    expect(html).not.toContain("host-level infrastructure credentials");
  });

  test("confirms when every expected secret is already present", () => {
    const html = adminBuiltSiteEditPage(
      site,
      TEST_SESSION,
      undefined,
      undefined,
      {
        expected: ["DB_URL", "NTFY_URL"],
        missing: [],
        ok: true,
        present: ["DB_URL", "NTFY_URL"],
      },
    );
    expect(html).toContain("All expected secrets are present");
    expect(html).not.toContain("add-secrets");
  });

  test("shows the error when secrets cannot be read", () => {
    const html = adminBuiltSiteEditPage(
      site,
      TEST_SESSION,
      undefined,
      undefined,
      {
        error:
          "BUNNY_API_KEY is not configured on this host, so site secrets can't be read.",
        ok: false,
      },
    );
    expect(html).toContain("BUNNY_API_KEY is not configured");
    expect(html).not.toContain("add-secrets");
  });

  test("notes when the secrets view is unavailable", () => {
    const html = adminBuiltSiteEditPage(site, TEST_SESSION);
    expect(html).toContain("Secrets status is unavailable");
  });
});

describe("adminBuiltSiteEditPage — update panel", () => {
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
    adminBuiltSiteEditPage(
      site,
      TEST_SESSION,
      undefined,
      undefined,
      undefined,
      { ...baseState, ...overrides },
    );

  test("shows the version, latest release, and an update button when behind", () => {
    const html = render();
    expect(html).toContain("Software update");
    expect(html).toContain("Thu, 01 Jan 2026 00:00:00 UTC");
    expect(html).toContain("2099-01-01 - Big Update (v2099-01-01-120000)");
    expect(html).toContain("An update is available");
    expect(html).toContain("/admin/built-sites/42/update");
    expect(html).toContain("Update this site");
  });

  test("shows up to date when the site is on the latest release", () => {
    const html = render({ updateAvailable: false, upToDate: true });
    expect(html).toContain("on the latest known release");
  });

  test("shows unknown when no database keys are stored", () => {
    const html = render({ siteVersionLabel: null, updateAvailable: false });
    expect(html).toContain("no read-only database credentials");
  });

  test("shows the read error when the site database is unreachable", () => {
    const html = render({
      siteVersionError: "connection refused",
      siteVersionLabel: null,
      updateAvailable: false,
    });
    expect(html).toContain("connection refused");
  });

  test("notes when the host has not checked for a release yet", () => {
    const html = render({ latestVersion: "", updateAvailable: false });
    expect(html).toContain("None checked yet");
  });

  test("explains when automatic update is unavailable", () => {
    const html = render({
      providerConfigured: false,
      updateAvailable: false,
      upToDate: false,
    });
    expect(html).toContain("Automatic update needs the provider API key");
    expect(html).not.toContain("Update this site");
  });
});
