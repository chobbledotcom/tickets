import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminBuiltSiteEditPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { testBuiltSite, testEventWithCount } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
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

  test("warns when no qualifying renewal tier is configured", () => {
    const site = testBuiltSite({ readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION, undefined, []);
    expect(html).toContain("Renewal tiers");
    expect(html).toContain("No renewal tier event is configured");
    expect(html).toContain("won't be able to renew");
  });

  test("lists each tier with units sold from attendee_count", () => {
    const monthly = testEventWithCount({
      attendee_count: 7,
      hidden: true,
      id: 11,
      months_per_unit: 1,
      name: "Monthly tier",
      purchase_only: true,
      unit_price: 500,
    });
    const annual = testEventWithCount({
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
    // Linked back to the event detail page
    expect(html).toContain('href="/admin/event/11"');
    expect(html).toContain('href="/admin/event/12"');
    // Warning copy must not appear when tiers exist
    expect(html).not.toContain("No renewal tier event is configured");
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
    expect(html).not.toContain("tier_event_id");
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
    expect(html).not.toContain("tier_event_id");
  });
});
