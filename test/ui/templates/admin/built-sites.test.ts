import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { adminBuiltSitesPage } from "#templates/admin/built-sites.tsx";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import { testBuiltSite, testListingWithCount } from "#test-utils/factories.ts";

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

  test("links each site name to its entity page and has no list delete link", () => {
    const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION);
    expect(html).toContain('href="/admin/built-sites/7">Linky</a>');
    expect(html).not.toContain("/admin/built-sites/7/delete");
  });

  test("warns when no qualifying renewal tier is configured", () => {
    const site = testBuiltSite({ readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION, undefined, []);
    expect(html).toContain("Renewal tiers");
    expect(html).toContain("No renewal tier listing is configured");
    expect(html).toContain("won't be able to renew");
  });

  test("keeps the read-only entity link but hides create actions", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const site = testBuiltSite({ id: 7, name: "Linky", readOnlyFrom: "" });
    const html = adminBuiltSitesPage([site], TEST_SESSION);
    expect(html).toContain("Linky");
    expect(html).not.toContain('href="/admin/built-sites/new"');
    expect(html).toContain('href="/admin/built-sites/7"');
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
