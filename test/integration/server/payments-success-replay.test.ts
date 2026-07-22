// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { clearSessionTokens } from "#shared/db/processed-payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { renderPaymentSuccess } from "#test/lib/payment-success-helpers.ts";
import { expectHtmlResponse, followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, signMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stageStripeCallback } from "#test-utils/staged-payments.ts";

// jscpd:ignore-end

type ReplayOptions = {
  clearTokensAfterFirstRender?: boolean;
  firstStatus?: number;
};

const renderReplay = async (
  sessionId: string,
  options: ReplayOptions = {},
): Promise<{ firstResponse: Response; html: string }> => {
  await stageStripeCallback(sessionId);
  const firstResponse = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  expect(firstResponse.status).toBe(options.firstStatus ?? 302);
  if (options.clearTokensAfterFirstRender) {
    await clearSessionTokens(sessionId);
  }

  const replayResponse = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  expect(replayResponse.status).toBe(200);
  const html = await replayResponse.text();
  expect(html).toContain("Thank you for your order");
  expect(html).not.toContain("mutated");
  return { firstResponse, html };
};

const stubPaidSession = (fields: {
  amount: number;
  email: string;
  items: string;
  name: string;
  sessionId: string;
  thankYouUrl?: string;
}) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: fields.amount,
      id: fields.sessionId,
      metadata: signedMeta(
        {
          email: fields.email,
          items: fields.items,
          name: fields.name,
          thank_you_url: fields.thankYouUrl ?? "",
        },
        fields.amount,
      ),
      payment_intent: `pi_${fields.sessionId}`,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

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
        await stageStripeCallback("cs_single_thankyou");
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        const html = await expectHtmlResponse(
          response,
          200,
          "https://example.com/single-thanks",
          "View your ticket",
        );
        expect(html).toContain('data-payment-result="success"');
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
        expect(html).not.toContain("mutated");
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
        // Replay finds the session already processed with no stored tokens, so it
        // renders directly via the single-listing fallback — which must suppress
        // the concealed member's thank-you URL too.
        const { html } = await renderReplay("cs_hidden_replay");
        expect(html).toContain('data-payment-result="success"');
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

      const mockRetrieve = stubPaidSession({
        amount: 1000,
        email: "dupe@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Dupe",
        sessionId: "cs_dupe_session",
      });

      try {
        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const { html } = await renderReplay("cs_dupe_session");
        expect(html).toContain("https://example.com/replay-thanks");

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

    test("uses the explicit thank-you URL for a replay without tokens", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/listing-fallback",
        unitPrice: 900,
      });
      const mockRetrieve = stubPaidSession({
        amount: 900,
        email: "explicit-replay@example.com",
        items: singleItem(listing.id, 1, 900),
        name: "Explicit Replay",
        sessionId: "cs_explicit_replay",
        thankYouUrl: "https://example.com/explicit-replay",
      });

      try {
        const { html } = await renderReplay("cs_explicit_replay", {
          clearTokensAfterFirstRender: true,
          firstStatus: 200,
        });
        expect(html).toContain("https://example.com/explicit-replay");
        expect(html).not.toContain("https://example.com/listing-fallback");
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
        // Replay (no tokens stored): renders directly via items.length === 1 branch
        const { firstResponse, html } = await renderReplay("cs_cart_single");
        const tokenResponse = await followRedirect(
          firstResponse,
          handleRequest,
        );
        const tokenHtml = await tokenResponse.text();
        // Single-listing cart: token path resolves one unique listing → shows thank_you_url
        expect(tokenHtml).toContain("redirected");
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
        thankYouUrl: "https://example.com/multi-one",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 2",
        thankYouUrl: "https://example.com/multi-two",
        unitPrice: 1000,
      });

      const mockRetrieve = stubPaidSession({
        amount: 1500,
        email: "multireplay@example.com",
        items: JSON.stringify([
          { e: listing1.id, p: 500, q: 1 },
          { e: listing2.id, p: 1000, q: 1 },
        ]),
        name: "Multi Replay",
        sessionId: "cs_multi_dupe",
      });

      try {
        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const { html } = await renderReplay("cs_multi_dupe");
        expect(html).not.toContain("https://example.com/multi-one");
        expect(html).not.toContain("https://example.com/multi-two");
      } finally {
        mockRetrieve.restore();
      }
    });
  });
});
