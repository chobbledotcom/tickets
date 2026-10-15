import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panels.tsx";
import { testBuiltSite } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

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
    says(html, "/renew/?t=real-customer-renewal-token");
    says(html, "rotate-renewal-token");
    says(html, "bump-deadline");
    says(html, "override-deadline");
    says(html, "re-sync-deadline");
    says(
      html,
      '<input id="bump_months" max="120" min="1" name="months" type="number" value="1">',
    );
    says(html, '<input id="override_date" name="date" type="date">');
    says(html, "<strong>Renewal URL:</strong> <code>");
    assert(!html.includes("tier_listing_id"));
  });

  test("labels provisioned deadline forms inline", () => {
    const html = String(renewalPanelFor(provisionedSite));
    says(html, '<label for="bump_months">Bump deadline by months');
    says(html, '<label for="override_date">Override deadline');
    assert(!html.includes("<h3>Bump deadline</h3>"));
  });

  test("shows provisioning and deadline actions for an unprovisioned site", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    says(html, "provision-renewal");
    says(html, "bump-deadline");
    says(html, "override-deadline");
    assert(!html.includes("rotate-renewal-token"));
    assert(!html.includes("re-sync-deadline"));
    says(
      html,
      '<label for="provision_months">Initial months</label><input id="provision_months" max="120" min="1" name="months" type="number" value="1">',
    );
  });

  test("labels unprovisioned deadline forms with headings", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    says(html, "<h3>Bump deadline</h3>");
    says(html, "<h3>Override deadline</h3>");
    assert(!html.includes('for="bump_months"'));
    assert(!html.includes('for="override_date"'));
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

    says(
      html,
      "The last provisioning did not reach the site. Provision again to retry.",
    );
    says(html, "provision-renewal");
    assert(!html.includes("rotate-renewal-token"));
    assert(!html.includes("bump-deadline"));
    assert(!html.includes("override-deadline"));
    assert(!html.includes("re-sync-deadline"));
    assert(!html.includes("/renew/?t="));
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

    assert(!html.includes("<details>"));
    assert(!html.includes("Raw ISO value"));
  });
});
