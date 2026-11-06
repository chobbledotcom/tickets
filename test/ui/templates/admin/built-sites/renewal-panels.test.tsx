import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panels.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
    expectIncludesAll(html, [
      "/renew/?t=real-customer-renewal-token",
      "rotate-renewal-token",
      "bump-deadline",
      "override-deadline",
      "re-sync-deadline",
      '<input id="bump_months" max="120" min="1" name="months" type="number" value="1">',
      '<input id="override_date" name="date" type="date">',
      "<strong>Renewal URL:</strong> <code>",
    ]);
    assert(!html.includes("tier_listing_id"));
  });

  test("labels provisioned deadline forms inline", () => {
    const html = String(renewalPanelFor(provisionedSite));
    expectIncludesAll(html, [
      '<label for="bump_months">Bump deadline by months',
      '<label for="override_date">Override deadline',
    ]);
    assert(!html.includes("<h3>Bump deadline</h3>"));
  });

  test("shows provisioning and deadline actions for an unprovisioned site", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expectIncludesAll(html, [
      "provision-renewal",
      "bump-deadline",
      "override-deadline",
    ]);
    assert(!html.includes("rotate-renewal-token"));
    assert(!html.includes("re-sync-deadline"));
    assertStringIncludes(
      html,
      '<label for="provision_months">Initial months</label><input id="provision_months" max="120" min="1" name="months" type="number" value="1">',
    );
  });

  test("labels unprovisioned deadline forms with headings", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expectIncludesAll(html, [
      "<h3>Bump deadline</h3>",
      "<h3>Override deadline</h3>",
    ]);
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

    expectIncludesAll(html, [
      "The last provisioning did not reach the site. Provision again to retry.",
      "provision-renewal",
    ]);
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
