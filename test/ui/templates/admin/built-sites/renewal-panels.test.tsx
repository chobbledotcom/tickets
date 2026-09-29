import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panels.tsx";
import { testBuiltSite } from "#test-utils/factories.ts";

describe("renewal panel", () => {
  const provisionedSite = testBuiltSite({
    readOnlyFrom: "2027-01-15T00:00:00Z",
    renewalToken: "real-customer-renewal-token",
    renewalTokenIndex: "some-index",
  });
  const unprovisionedSite = testBuiltSite({
    readOnlyFrom: "",
    renewalTokenIndex: null,
  });

  test("shows every provisioned-site action and the real renewal URL", () => {
    const html = String(renewalPanelFor(provisionedSite));
    expect(html).toContain("/renew/?t=real-customer-renewal-token");
    expect(html).toContain("rotate-renewal-token");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).toContain("re-sync-deadline");
    expect(html).toContain(
      '<input id="bump_months" max="120" min="1" name="months" type="number" value="1">',
    );
    expect(html).toContain(
      '<input id="override_date" name="date" type="date">',
    );
    expect(html).toContain("<strong>Renewal URL:</strong> <code>");
    expect(html).not.toContain("tier_listing_id");
  });

  test("labels provisioned deadline forms inline", () => {
    const html = String(renewalPanelFor(provisionedSite));
    expect(html).toContain('<label for="bump_months">Bump deadline by months');
    expect(html).toContain('<label for="override_date">Override deadline');
    expect(html).not.toContain("<h3>Bump deadline</h3>");
  });

  test("shows provisioning and deadline actions for an unprovisioned site", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expect(html).toContain("provision-renewal");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).not.toContain("rotate-renewal-token");
    expect(html).not.toContain("re-sync-deadline");
    expect(html).toContain(
      '<label for="provision_months">Initial months</label><input id="provision_months" max="120" min="1" name="months" type="number" value="1">',
    );
  });

  test("labels unprovisioned deadline forms with headings", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expect(html).toContain("<h3>Bump deadline</h3>");
    expect(html).toContain("<h3>Override deadline</h3>");
    expect(html).not.toContain('for="bump_months"');
    expect(html).not.toContain('for="override_date"');
  });

  test("shows only the retry provision form for a reserved-unconfirmed site", () => {
    const html = String(
      renewalPanelFor(
        testBuiltSite({
          readOnlyFrom: "",
          renewalToken: "reserved-token",
          renewalTokenIndex: "reserved-index",
        }),
      ),
    );

    expect(html).toContain(
      "The last provisioning did not reach the site. Provision again to retry.",
    );
    expect(html).toContain("provision-renewal");
    expect(html).not.toContain("rotate-renewal-token");
    expect(html).not.toContain("bump-deadline");
    expect(html).not.toContain("override-deadline");
    expect(html).not.toContain("re-sync-deadline");
    expect(html).not.toContain("/renew/?t=");
  });

  test("omits raw deadline details when no deadline is set", () => {
    const html = String(
      renewalPanelFor(
        testBuiltSite({
          readOnlyFrom: "",
          renewalToken: "renewal-token",
          renewalTokenIndex: "renewal-index",
        }),
      ),
    );

    expect(html).not.toContain("<details>");
    expect(html).not.toContain("Raw ISO value");
  });
});
