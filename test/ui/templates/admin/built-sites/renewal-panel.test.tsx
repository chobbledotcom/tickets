import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panel.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testBuiltSite, testListingWithCount } from "#test-utils/factories.ts";

const monthlyTier = testListingWithCount({
  hidden: true,
  id: 11,
  months_per_unit: 1,
  name: "Monthly tier",
  purchase_only: true,
  unit_price: 500,
});

const annualTier = testListingWithCount({
  hidden: true,
  id: 12,
  months_per_unit: 12,
  name: "Annual tier",
  purchase_only: true,
  unit_price: 5000,
});

const TIERS = [monthlyTier, annualTier];

const render = (
  site: ReturnType<typeof testBuiltSite>,
  tiers = TIERS,
): string => String(renewalPanelFor(site, tiers));

describe("renewal panel", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  const provisionedSite = testBuiltSite({
    readOnlyFrom: "2027-01-15T00:00:00Z",
    renewalToken: "real-customer-renewal-token",
    renewalTokenIndex: "some-index",
  });
  const unprovisionedSite = testBuiltSite({
    readOnlyFrom: "",
    renewalTokenIndex: null,
  });

  describe("deadline actions", () => {
    test("shows every provisioned-site action and the real renewal URL", () => {
      const html = render(provisionedSite);
      expect(html).toContain("/renew/?t=real-customer-renewal-token");
      expect(html).not.toContain("?t=<token>");
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
    });

    test("labels provisioned deadline forms inline", () => {
      const html = render(provisionedSite);
      expect(html).toContain(
        '<label for="bump_months">Bump deadline by months',
      );
      expect(html).toContain('<label for="override_date">Override deadline');
      expect(html).not.toContain("<h3>Bump deadline</h3>");
    });

    test("shows provisioning and deadline actions for an unprovisioned site", () => {
      const html = render(unprovisionedSite);
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
      const html = render(unprovisionedSite);
      expect(html).toContain("<h3>Bump deadline</h3>");
      expect(html).toContain("<h3>Override deadline</h3>");
      expect(html).not.toContain('for="bump_months"');
      expect(html).not.toContain('for="override_date"');
    });

    test("omits raw deadline details when no deadline is set", () => {
      const html = render(
        testBuiltSite({
          readOnlyFrom: "",
          renewalToken: "renewal-token",
          renewalTokenIndex: "renewal-index",
        }),
      );
      expect(html).not.toContain("<details>");
      expect(html).not.toContain("Raw ISO value");
    });
  });

  describe("renewal tier", () => {
    test("says the customer picks any tier when none is chosen", () => {
      const html = render(testBuiltSite({ renewalTierListingId: null }));
      expect(html).toContain("<strong>This site renews on:</strong> Any tier.");
      expect(html).toContain("set-renewal-tier");
      expect(html).toContain('<option selected value="">Any tier.');
    });

    test("names the chosen tier with its months and price, and links it", () => {
      const html = render(testBuiltSite({ renewalTierListingId: 12 }));
      expect(html).toContain(
        `<a href="/admin/listing/12">Annual tier — 12 months for ${formatCurrency(5000)}</a>`,
      );
      expect(html).toContain('<option selected value="12">');
      expect(html).not.toContain('<option selected value="11">');
    });

    test("offers every qualifying tier as a choice", () => {
      const html = render(testBuiltSite({ renewalTierListingId: null }));
      expect(html).toContain(
        `value="11">Monthly tier — 1 month for ${formatCurrency(500)}<`,
      );
      expect(html).toContain(
        `value="12">Annual tier — 12 months for ${formatCurrency(5000)}<`,
      );
    });

    test("labels the picker and names the field the action reads", () => {
      const html = render(testBuiltSite({ renewalTierListingId: null }));
      // The label points at the select, and the select carries the field name
      // handleSetRenewalTier reads.
      expect(html).toContain(
        '<label for="renewal_tier">Change the renewal tier</label>' +
          '<select id="renewal_tier" name="tier_id">',
      );
    });

    test("still offers the picker when only one tier qualifies", () => {
      const html = render(testBuiltSite({ renewalTierListingId: null }), [
        monthlyTier,
      ]);
      expect(html).toContain("set-renewal-tier");
      expect(html).toContain(`value="${monthlyTier.id}">Monthly tier`);
      expect(html).not.toContain("No renewal tier listing is configured");
    });

    test("warns when the chosen tier no longer qualifies", () => {
      const html = render(testBuiltSite({ renewalTierListingId: 99 }));
      expect(html).toContain(
        "Listing #99 is no longer a renewal tier. The customer sees every tier until you pick a new one.",
      );
      expect(html).toContain("<strong>This site renews on:</strong> Any tier.");
      expect(html).toContain('<option selected value="">Any tier.');
    });

    test("asks for a tier listing instead of an empty picker", () => {
      const html = render(testBuiltSite({ renewalTierListingId: null }), []);
      expect(html).toContain("No renewal tier listing is configured");
      expect(html).not.toContain("set-renewal-tier");
    });

    test("still lets a retired tier be cleared when no tier is left", () => {
      const html = render(testBuiltSite({ renewalTierListingId: 99 }), []);
      expect(html).toContain("No renewal tier listing is configured");
      expect(html).toContain("Listing #99 is no longer a renewal tier.");
      // The warning says to pick a new tier, so the picker has to be there to
      // act on it — with the one choice that clears the retired listing.
      expect(html).toContain("set-renewal-tier");
      expect(html).toContain('<option selected value="">Any tier.');
      expect(html).not.toContain('value="11"');
    });

    test("offers the tier picker on an unprovisioned site too", () => {
      const html = render(
        testBuiltSite({ renewalTierListingId: 11, renewalTokenIndex: null }),
      );
      expect(html).toContain("set-renewal-tier");
      expect(html).toContain(
        `<a href="/admin/listing/11">Monthly tier — 1 month for ${formatCurrency(500)}</a>`,
      );
    });
  });
});
