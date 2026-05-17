import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import {
  getAllBuiltSites,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  assertPublicHtml,
  createTestEvent,
  deactivateTestEvent,
  describeWithEnv,
  expectHtmlResponse,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
  setupStripe,
} from "#test-utils";

const setupRenewalSite = async (tierEventId: number) => {
  const token = generateSecureToken();
  const tokenIndex = await hmacHash(token);
  await insertBuiltSite("Renewal Test Site", "renewal.b-cdn.net");
  const sites = await getAllBuiltSites();
  const site = sites.find((s) => s.name === "Renewal Test Site")!;
  await updateBuiltSiteRenewalState(site.id, {
    readOnlyFrom: "2026-09-01T00:00:00Z",
    renewalToken: token,
    renewalTokenIndex: tokenIndex,
    renewalTierEventId: tierEventId,
  });
  return { site, token };
};

describeWithEnv("routes > renewal", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  describe("GET /renew/", () => {
    test("renders renewal form with site name and tier price for valid token", async () => {
      const tier = await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const html = await assertPublicHtml(
        `/renew/?t=${encodeURIComponent(token)}`,
        "Renew Renewal Test Site",
        "per month",
      );
      expect(html).toContain("01/09/2026");
      expect(html).toContain("csrf_token");
      expect(html).toContain("Pay and Renew");
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

    test("returns 404 when site has no renewal tier configured", async () => {
      await insertBuiltSite("No Tier Site", "notier.b-cdn.net");

      const response = await handleRequest(
        mockRequest("/renew/?t=some-token"),
      );
      expect(response.status).toBe(404);
    });

    test("renders error page when tier event is inactive", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      await deactivateTestEvent(tier.id);
      const { token } = await setupRenewalSite(tier.id);

      const html = await expectHtmlResponse(
        await handleRequest(
          mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
        ),
        200,
        "Renewal Unavailable",
        "no longer valid",
      );
      expect(html).not.toContain("Pay and Renew");
    });

    test("renders error page when tier event is missing from database", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token, site } = await setupRenewalSite(tier.id);

      await updateBuiltSiteRenewalState(site.id, {
        renewalTierEventId: 99999,
      });

      const response = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Renewal Unavailable");
      expect(html).not.toContain("Pay and Renew");
    });

    test("renders error page when tier event has months_per_unit <= 0", async () => {
      const tier = await createTestEvent({
        hidden: true,
        monthsPerUnit: 0,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const html = await expectHtmlResponse(
        await handleRequest(
          mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
        ),
        200,
        "Renewal Unavailable",
      );
      expect(html).not.toContain("Pay and Renew");
    });
  });

  describe("POST /renew/", () => {
    test("creates checkout session with site_token in metadata and quantity=3", async () => {
      await setupStripe();
      const tier = await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const getResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const getHtml = await getResponse.text();
      const csrf = extractCsrfToken(getHtml)!;

      const mockCreate = stub(stripePaymentProvider, "createCheckoutSession", () =>
        Promise.resolve({
          checkoutUrl: "https://checkout.stripe.com/renew",
          sessionId: "cs_renew_test",
        }));

      try {
        const response = await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            quantity: "3",
          }),
        );
        expect(response.status).toBe(302);

        const call = mockCreate.calls[0];
        const intent = call!.args[0] as import("#shared/payments.ts").CheckoutIntent;
        expect(intent.siteToken).toBe(token);
        expect(intent.items[0]!.quantity).toBe(3);
        expect(intent.items[0]!.eventId).toBe(tier.id);
        expect(intent.items[0]!.unitPrice).toBe(500);
      } finally {
        mockCreate.restore();
      }
    });

    test("clamps quantity=0 to 1", async () => {
      await setupStripe();
      const tier = await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 12,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const getResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const getHtml = await getResponse.text();
      const csrf = extractCsrfToken(getHtml)!;

      const mockCreate = stub(stripePaymentProvider, "createCheckoutSession", () =>
        Promise.resolve({
          checkoutUrl: "https://checkout.stripe.com/renew",
          sessionId: "cs_renew_zero",
        }));

      try {
        await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            quantity: "0",
          }),
        );

        const intent = mockCreate.calls[0]!.args[0] as import("#shared/payments.ts").CheckoutIntent;
        expect(intent.items[0]!.quantity).toBe(1);
      } finally {
        mockCreate.restore();
      }
    });

    test("clamps quantity exceeding max_quantity down", async () => {
      await setupStripe();
      const tier = await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        maxQuantity: 5,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const getResponse = await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      );
      const getHtml = await getResponse.text();
      const csrf = extractCsrfToken(getHtml)!;

      const mockCreate = stub(stripePaymentProvider, "createCheckoutSession", () =>
        Promise.resolve({
          checkoutUrl: "https://checkout.stripe.com/renew",
          sessionId: "cs_renew_over",
        }));

      try {
        await handleRequest(
          mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
            csrf_token: csrf,
            email: "renew@example.com",
            name: "Renewer",
            quantity: "99",
          }),
        );

        const intent = mockCreate.calls[0]!.args[0] as import("#shared/payments.ts").CheckoutIntent;
        expect(intent.items[0]!.quantity).toBe(5);
      } finally {
        mockCreate.restore();
      }
    });

    test("returns 403 without CSRF token", async () => {
      const tier = await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const { token } = await setupRenewalSite(tier.id);

      const response = await handleRequest(
        mockFormRequest(`/renew/?t=${encodeURIComponent(token)}`, {
          email: "renew@example.com",
          name: "Renewer",
          quantity: "1",
        }),
      );
      expect(response.status).toBe(403);
    });
  });
});
