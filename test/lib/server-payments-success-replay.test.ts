// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { stripeApi } from "#shared/stripe.ts";
import { expectHtmlResponse, followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, signMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { renderPaymentSuccess } from "./payment-success-helpers.ts";

// jscpd:ignore-end

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_thankyou",
          metadata: signMeta(
            {
              email: "single@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Single",
            },
            500,
          ),
          payment_intent: "pi_single_thankyou",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "https://example.com/single-thanks",
          "View your ticket",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("suppresses thank_you_url for a hidden package's sole member", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Hidden Success Pkg",
        slug: "hidden-success-pkg",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Concealed Member",
        thankYouUrl: "https://example.com/concealed-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_hidden_pkg",
          metadata: signedMeta(
            {
              email: "concealed@example.com",
              // A package member carries its package edge tag (k:"p", r:group)
              // so the webhook's tree revalidation resolves it as a package
              // member rather than a standalone listing.
              items: JSON.stringify([
                { e: listing.id, k: "p", p: 500, q: 1, r: group.id },
              ]),
              name: "Concealed Buyer",
            },
            500,
          ),
          payment_intent: "pi_hidden_pkg",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const { redirectResponse, response, html } =
          await renderPaymentSuccess("cs_hidden_pkg");
        expect(redirectResponse.status).toBe(302);
        expect(response.status).toBe(200);
        // The ticket link still shows, but the concealed member's thank-you URL
        // (which would meta-refresh to the listing the package hid) must not leak.
        expect(html).toContain("View your ticket");
        expect(html).not.toContain("https://example.com/concealed-thanks");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("suppresses thank_you_url on replay for a hidden package's sole member", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Hidden Replay Pkg",
        slug: "hidden-replay-pkg",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Concealed Replay Member",
        thankYouUrl: "https://example.com/concealed-replay",
        unitPrice: 700,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 700,
          id: "cs_hidden_replay",
          metadata: signedMeta(
            {
              email: "replay@example.com",
              // Package member tagged with its edge (k:"p", r:group) so the
              // webhook's tree revalidation resolves it as a package member.
              items: JSON.stringify([
                { e: listing.id, k: "p", p: 700, q: 1, r: group.id },
              ]),
              name: "Replay Buyer",
            },
            700,
          ),
          payment_intent: "pi_hidden_replay",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request redirects with tokens (no stored tokens — a hidden package
        // carries no explicit thank-you URL, so storeTokens is false).
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_hidden_replay"),
        );
        expect(response1.status).toBe(302);
        // Replay finds the session already processed with no stored tokens, so it
        // renders directly via the single-listing fallback — which must suppress
        // the concealed member's thank-you URL too.
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_hidden_replay"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        expect(html).not.toContain("https://example.com/concealed-replay");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_dupe_session",
          metadata: signMeta(
            {
              email: "dupe@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Dupe",
            },
            1000,
          ),
          payment_intent: "pi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");

        // Should still only have one attendee
        const { getAttendeesRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles single-item cart session replay (shows thank_you_url)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_cart_single",
          metadata: signMeta(
            {
              email: "cartsingle@example.com",
              items: JSON.stringify([{ e: listing.id, p: 800, q: 1 }]),
              name: "Cart Single Buyer",
            },
            800,
          ),
          payment_intent: "pi_cart_single",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request: process and redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response1.status).toBe(302);

        // Follow redirect to render success page with tokens
        const tokenResponse = await followRedirect(response1, handleRequest);
        const tokenHtml = await tokenResponse.text();
        // Single-listing cart: token path resolves one unique listing → shows thank_you_url
        expect(tokenHtml).toContain("redirected");

        // Replay (no tokens stored): renders directly via items.length === 1 branch
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        // Single-item cart replay also shows thank_you_url
        expect(html).toContain("redirected");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles ticket duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_dupe",
          metadata: signMeta(
            {
              email: "multireplay@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Multi Replay",
            },
            1500,
          ),
          payment_intent: "pi_multi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
      } finally {
        mockRetrieve.restore();
      }
    });
  });
});
