import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { builtSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { provisionTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { postExpectingNoCheckout } from "./_shared-checkout.ts";

const setupRenewalSite = async () => {
  await insertBuiltSite(
    "Renewal Test Site",
    "renewal.b-cdn.net",
    "",
    "",
    false,
    "7101",
  );
  const sites = await builtSites.getAll();
  const site = sites.find((s) => s.name === "Renewal Test Site")!;
  const { token } = await provisionTestBuiltSite(site.id, {
    readOnlyFrom: "2026-09-01T00:00:00Z",
  });
  return { site, token };
};

describeWithEnv("routes > renewal", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  /** Create a single qualifying renewal tier listing + provisioned renewal
   *  site, then GET `/renew/?t=…`. Collapses the repeated fixture (hidden,
   *  monthly, purchase-only, £5 listing) + `setupRenewalSite` + `mockRequest`
   *  scaffold shared by the noindex, terms, and deadline tests. */
  const visitRenewalPicker = async (): Promise<{
    response: Response;
    token: string;
  }> => {
    await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
    const { token } = await setupRenewalSite();
    const response = await handleRequest(
      mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
    );
    return { response, token };
  };

  describe("GET /renew/", () => {
    test("renders renewal picker with every qualifying tier listing", async () => {
      const monthly = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 1,
        name: "Monthly tier",
        purchaseOnly: true,
        unitPrice: 500,
      });
      const annual = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 12,
        name: "Annual tier",
        purchaseOnly: true,
        unitPrice: 5000,
      });
      const { token } = await setupRenewalSite();

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Renew Renewal Test Site",
      );
      // Both tiers must appear as separately-selectable picker rows.
      expect(html).toContain(`quantity_${monthly.id}`);
      expect(html).toContain(`quantity_${annual.id}`);
      expect(html).toContain("Monthly tier");
      expect(html).toContain("Annual tier");
      // The form posts back to /renew/?t=… so the token survives submission.
      expect(html).toContain(`/renew/?t=${encodeURIComponent(token)}`);
      expect(html).toContain("csrf_token");
    });

    test("does not show terms and conditions or agreement checkbox", async () => {
      const { response } = await visitRenewalPicker();
      const html = await response.text();
      expect(html).not.toContain("agree_terms");
      expect(html).not.toContain("terms-agree");
    });

    test("marks renewal picker as noindex", async () => {
      const { response } = await visitRenewalPicker();
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.has("x-robots-noindex")).toBe(false);
    });

    test("shows the current deadline in the page", async () => {
      const { response } = await visitRenewalPicker();
      const html = await response.text();
      expect(html).toContain("Tuesday 1 September 2026");
    });

    test("omits the 'current deadline' wording when no deadline is set", async () => {
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      // A provisioned site whose readOnlyFrom was never populated (e.g. CDN
      // push failed during initial provisioning) still renders a usable picker.
      await insertBuiltSite("No Deadline Site", "nd.b-cdn.net");
      const sites = await builtSites.getAll();
      const site = sites.find((s) => s.name === "No Deadline Site")!;
      const { token } = await provisionTestBuiltSite(site.id);

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const html = await response.text();
      expect(html).toContain("Pick a tier and quantity below");
      expect(html).not.toContain("Current deadline:");
    });

    test("renders the postcode search for an address-collecting tier", async () => {
      // The renewal picker is the same booking form, so a tier that collects
      // an address gets the address-lookup panel too — and its settings must
      // be declared in the /renew preload bundle for this render to pass the
      // settings-read audit.
      await createTestListing({
        fields: "address",
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite();
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.addressLookup.provider("easypostcodes");
      await settings.update.addressLookup.apiKey("test-key");

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );

      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("data-address-lookup");
    });

    test("returns 404 for unknown token", async () => {
      const response = await handleRequest(
        mockRequest("/renew/?t=unknown-token"),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when token is missing", async () => {
      const response = await handleRequest(mockRequest("/renew/"));
      expect(response.status).toBe(404);
    });

    test("renders error page when no qualifying tier listings exist", async () => {
      const { token } = await setupRenewalSite();

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Renewal Unavailable",
        "no longer valid",
      );
      expect(html).not.toContain("quantity_");
    });

    test("excludes inactive tier listings from the picker", async () => {
      const active = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Active tier",
        purchaseOnly: true,
        unitPrice: 500,
      });
      const stale = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Stale tier",
        purchaseOnly: true,
        unitPrice: 700,
      });
      await deactivateTestListing(stale.id);
      const { token } = await setupRenewalSite();

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const html = await response.text();
      expect(html).toContain(`quantity_${active.id}`);
      expect(html).not.toContain(`quantity_${stale.id}`);
    });
  });

  describe("POST /renew/", () => {
    test("creates checkout session for the chosen tier with siteToken in intent", async () => {
      await setupStripe();
      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite();

      const getResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const csrf = extractCsrfToken(await getResponse.text())!;

      const { checkout, getCaptured } = stubCheckout("cs_renew_test");

      try {
        const response = await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            [`quantity_${tier.id}`]: "3",
          }),
        );
        expect(response.status).toBe(302);

        const intent = getCaptured()!;
        expect(intent.siteToken).toBe(token);
        expect(intent.items).toHaveLength(1);
        expect(intent.items[0]!.listingId).toBe(tier.id);
        expect(intent.items[0]!.quantity).toBe(3);
        expect(intent.items[0]!.unitPrice).toBe(500);
      } finally {
        checkout.restore();
      }
    });

    test("creates a multi-item checkout when more than one tier is selected", async () => {
      await setupStripe();
      const monthly = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const annual = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 12,
        purchaseOnly: true,
        unitPrice: 5000,
      });
      const { token } = await setupRenewalSite();

      const csrf = extractCsrfToken(
        await (
          await handleRequest(
            mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
          )
        ).text(),
      )!;

      const { checkout, getCaptured } = stubCheckout("cs_multi");

      try {
        await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            [`quantity_${monthly.id}`]: "2",
            [`quantity_${annual.id}`]: "1",
          }),
        );
        const intent = getCaptured()!;
        expect(intent.siteToken).toBe(token);
        const ids = intent.items.map((i) => i.listingId).sort();
        expect(ids).toEqual([monthly.id, annual.id].sort());
      } finally {
        checkout.restore();
      }
    });

    test("free renewal tier still applies the site renewal", async () => {
      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 0,
      });
      const { site, token } = await setupRenewalSite();

      const csrf = extractCsrfToken(
        await (
          await handleRequest(
            mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
          )
        ).text(),
      )!;

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      try {
        const response = await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            [`quantity_${tier.id}`]: "2",
          }),
        );
        expect(response.status).toBe(302);

        const updated = (await builtSites.getAll()).find(
          (s) => s.id === site.id,
        )!;
        expect(updated.readOnlyFrom).toBe(
          addMonthsIso("2026-09-01T00:00:00Z", 2),
        );
        const readOnlyCalls = secretStub.calls.filter(
          (c) => c.args[1] === "READ_ONLY_FROM",
        );
        expect(readOnlyCalls).toHaveLength(1);
      } finally {
        secretStub.restore();
      }
    });

    test("redirects (no checkout) when CSRF token is missing", async () => {
      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite();

      const { response, checkoutCalls } = await postExpectingNoCheckout(
        mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
          email: "renew@example.com",
          name: "Renewer",
          [`quantity_${tier.id}`]: "1",
        }),
      );
      // Standard ticket-form behavior: missing CSRF → redirect back to the
      // form (no payment session created).
      expect(response.status).toBe(302);
      expect(checkoutCalls).toBe(0);
    });
  });
});
