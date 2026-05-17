import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminBuiltSiteEditPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { testBuiltSite } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };
const NO_TIERS: {
  id: number;
  name: string;
  unit_price: number;
  months_per_unit: number;
}[] = [];

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
});

describe("adminBuiltSiteEditPage — provisioned site", () => {
  const provisionedSite = testBuiltSite({
    readOnlyFrom: "2027-01-15T00:00:00Z",
    renewalTierEventId: 5,
    renewalTokenIndex: "some-index",
  });

  test("shows renewal URL, tier dropdown, rotate/bump/override/re-sync forms", () => {
    const html = adminBuiltSiteEditPage(
      provisionedSite,
      TEST_SESSION,
      NO_TIERS,
    );
    expect(html).toContain("Renewal URL");
    expect(html).toContain("tier_event_id");
    expect(html).toContain("rotate-renewal-token");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).toContain("re-sync-deadline");
    expect(html).toContain("Rotate token");
    expect(html).toContain("Re-sync deadline");
  });
});

describe("adminBuiltSiteEditPage — unprovisioned site", () => {
  const unprovisionedSite = testBuiltSite({
    readOnlyFrom: "",
    renewalTierEventId: null,
    renewalTokenIndex: null,
  });

  test("shows Provision Renewal form, bump/override forms; no Rotate/Re-sync", () => {
    const html = adminBuiltSiteEditPage(
      unprovisionedSite,
      TEST_SESSION,
      NO_TIERS,
    );
    expect(html).toContain("Provision renewal");
    expect(html).toContain("provision-renewal");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).not.toContain("rotate-renewal-token");
    expect(html).not.toContain("re-sync-deadline");
  });
});
