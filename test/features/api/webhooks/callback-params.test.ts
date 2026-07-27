import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";
import {
  expectResponseWithText,
  routedResponse,
  stubRetrieveSession,
} from "./helpers.ts";

describeWithEnv("payment callback params", { db: true }, () => {
  setupErrorSpy();

  /** Assert a callback response is a 400 with the t("payment.error.invalid_callback") body. */
  const expectInvalidCallback = (response: Response): Promise<void> =>
    expectResponseWithText(response, 400, t("payment.error.invalid_callback"));

  test("returns error for missing session_id on cancel", async () => {
    await expectInvalidCallback(
      await routedResponse(mockRequest("/payment/cancel")),
    );
  });

  test("returns error for missing session_id on success", async () => {
    await expectInvalidCallback(
      await routedResponse(mockRequest("/payment/success")),
    );
  });

  test("returns error for success with no params", async () => {
    // No query params at all: paramKeys falls back to "none", referer to "none"
    const response = await routedResponse(
      mockRequest("/payment/success", { headers: {} }),
    );
    expect(response.status).toBe(400);
  });

  test("returns error for success with no session_id or tokens", async () => {
    const response = await routedResponse(
      mockRequest("/payment/success?foo=bar&baz=qux"),
    );
    expect(response.status).toBe(400);
  });

  test("cancel returns error when no provider configured", async () => {
    await expectResponseWithText(
      await routedResponse(
        mockRequest("/payment/cancel?session_id=cs_noprovider"),
      ),
      400,
      t("payment.error.provider_not_configured"),
    );
  });

  test("cancel returns error when session not found", async () => {
    await setupStripe();
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(null),
    );
    try {
      await expectResponseWithText(
        await routedResponse(
          mockRequest("/payment/cancel?session_id=cs_missing"),
        ),
        400,
        t("payment.error.session_not_recognized"),
      );
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified success page uses + separator in ticket URL", async () => {
    const { createTestAttendeeWithToken } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
    const a = await createTestAttendeeWithToken("Alice", "alice@example.com");
    const b = await createTestAttendeeWithToken("Bob", "bob@example.com");

    const tokensParam = `${a.token}%2B${b.token}`;
    const response = await routedResponse(
      mockRequest(`/payment/success?tokens=${tokensParam}`),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="/t/${a.token}+${b.token}"`);
    expect(html).toContain('data-payment-result="success"');
  });

  test("token-verified single-listing success page shows thank-you URL", async () => {
    const { createTestAttendeeWithToken } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@example.com",
      { thankYouUrl: "https://example.com/alice-thanks" },
    );

    const response = await routedResponse(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="/t/${token}"`);
    expect(html).toContain('data-payment-result="success"');
    // The listing's thank-you URL is resolved and rendered
    expect(html).toContain("https://example.com/alice-thanks");
  });

  test("already-processed redirect keeps the stable ticket URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });

    const retrieve = await stubRetrieveSession(
      "cs_clearing",
      "pi_clearing",
      listing,
      1000,
    );

    try {
      const first = await routedResponse(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      expect(first.status).toBe(302);
      const redirect = first.headers.get("location") ?? "";
      expect(redirect).toContain("/payment/success?tokens=");

      const second = await routedResponse(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      expect(second.status).toBe(302);
      expect(second.headers.get("location")).toBe(redirect);
    } finally {
      retrieve.restore();
    }
  });

  test("already-processed with explicit thank-you preserves it over listing's URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });

    const retrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      metadata: signedMeta(
        {
          email: "bob@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bob",
          thank_you_url: "https://example.com/explicit-thanks",
        },
        1000,
      ),
      paymentIntent: "pi_explicit",
      sessionId: "cs_explicit",
    });

    try {
      // First hit: processes and direct-renders with explicit thank-you + tokens
      const first = await routedResponse(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(firstHtml).toContain('data-payment-result="success"');
      expect(firstHtml).toContain("https://example.com/explicit-thanks");

      const second = await routedResponse(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain('data-payment-result="success"');
      expect(secondHtml).toContain("https://example.com/explicit-thanks");
      expect(secondHtml).not.toContain("https://example.com/listing-thanks");
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified hidden package member success page suppresses thank-you URL", async () => {
    const { createHiddenPackageGroup } = await import(
      "#test-utils/db-helpers/groups.ts"
    );
    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );

    const group = await createHiddenPackageGroup("Hidden Pkg");
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      thankYouUrl: "https://example.com/concealed-thanks",
      unitPrice: 1000,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Hidden",
      "hidden@example.com",
      1,
    );
    const token = attendee.ticket_token;

    const response = await routedResponse(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-payment-result="success"');
    expect(html).toContain(`href="/t/${token}"`);
    // The hidden package member's thank-you URL must not leak
    expect(html).not.toContain("https://example.com/concealed-thanks");
    // No meta-refresh redirect should be rendered (thankYouUrl is empty)
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("already-processed for a since-deleted listing renders no thank-you URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/deleted-listing-thanks",
      unitPrice: 1000,
    });

    const { deleteListing } = await import("#shared/db/listings/delete.ts");
    const retrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      metadata: signedMeta(
        {
          email: "carol@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Carol",
        },
        1000,
      ),
      paymentIntent: "pi_deleted_listing",
      sessionId: "cs_deleted_listing",
    });

    try {
      // First hit: processes and redirects (clearing tokens)
      const first = await routedResponse(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      expect(first.status).toBe(302);

      // The booking has to be finished off before the listing can go: a
      // half-finished payment holds on to what it still needs.
      await settleDeferredPaymentWork();
      await deleteListing(listing.id);

      // Second hit: listing gone, tokens cleared; singleListingThankYou
      // returns "" for a deleted listing (no meta-refresh, no redirect link)
      // The first replay hands the ticket over and uses up its link; the one
      // after it has no ticket left to send anyone to.
      const replay = await routedResponse(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      expect(replay.status).toBe(302);
      const second = await routedResponse(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain('data-payment-result="success"');
      expect(secondHtml).not.toContain(
        "https://example.com/deleted-listing-thanks",
      );
      expect(secondHtml).not.toContain('http-equiv="refresh"');
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified multi-listing success page suppresses thank-you URL", async () => {
    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );

    const listingA = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/thanks-a",
      unitPrice: 1000,
    });
    const listingB = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/thanks-b",
      unitPrice: 1000,
    });

    const { attendee: attendeeA } = await createTestAttendeeDirect(
      listingA.id,
      "MultiA",
      "multia@example.com",
      1,
    );
    const { attendee: attendeeB } = await createTestAttendeeDirect(
      listingB.id,
      "MultiB",
      "multib@example.com",
      1,
    );
    const tokens = [attendeeA.ticket_token, attendeeB.ticket_token].join("+");

    const response = await routedResponse(
      mockRequest(`/payment/success?tokens=${encodeURIComponent(tokens)}`),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-payment-result="success"');
    expect(html).toContain(`href="/t/${tokens}"`);
    // Multiple listings: no single thank-you URL should be picked
    expect(html).not.toContain("https://example.com/thanks-a");
    expect(html).not.toContain("https://example.com/thanks-b");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("returns error for invalid tokens param", async () => {
    await expectInvalidCallback(
      await routedResponse(mockRequest("/payment/success?tokens=BOGUS")),
    );
  });
});
