import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { routeRequest, stubRetrieveSession } from "./helpers.ts";

describeWithEnv("payment callback params", { db: true }, () => {
  const errors = setupErrorSpy();

  /** Assert a callback response is a 400 with the "Invalid payment callback" body. */
  const expectInvalidCallback = async (
    response: Response | null,
  ): Promise<void> => {
    expect((response ?? new Response()).status).toBe(400);
    expect(await (response ?? new Response()).text()).toContain(
      "Invalid payment callback",
    );
  };

  /** Assert a callback response is a 400 with the given text substring and
   * logged error substring. */
  const expect400With = async (
    response: Response | null,
    textSubstring: string,
    errorSubstring: string,
  ): Promise<void> => {
    expect((response ?? new Response()).status).toBe(400);
    expect(await (response ?? new Response()).text()).toContain(textSubstring);
    expect(errors.contains(errorSubstring)).toBe(true);
  };

  test("returns error for missing session_id on cancel and logs error", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/cancel")),
    );
    expect(
      errors.contains("Payment callback missing session_id parameter"),
    ).toBe(true);
  });

  test("returns error for missing session_id on success", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/success")),
    );
  });

  test("returns error for success with no params and logs none fallback", async () => {
    // No query params at all: paramKeys falls back to "none", referer to "none"
    const response = await routeRequest(
      mockRequest("/payment/success", { headers: {} }),
    );
    expect((response ?? new Response()).status).toBe(400);
    expect(errors.contains("params=[none]")).toBe(true);
    expect(errors.contains("referer=none")).toBe(true);
  });

  test("returns error for success with no session_id or tokens and logs error", async () => {
    const response = await routeRequest(
      mockRequest("/payment/success?foo=bar&baz=qux"),
    );
    expect((response ?? new Response()).status).toBe(400);
    expect(errors.contains("no session_id or tokens")).toBe(true);
    expect(errors.contains("params=[foo,baz]")).toBe(true);
    expect(errors.contains("referer=none")).toBe(true);
  });

  test("cancel returns error when no provider configured and logs cancel error", async () => {
    await expect400With(
      await routeRequest(
        mockRequest("/payment/cancel?session_id=cs_noprovider"),
      ),
      "Payment provider not configured",
      "[cancel] No provider configured",
    );
  });

  test("cancel returns error when session not found and logs cancel error", async () => {
    await setupStripe();
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(null),
    );
    try {
      await expect400With(
        await routeRequest(
          mockRequest("/payment/cancel?session_id=cs_missing"),
        ),
        "Payment session not found",
        "[cancel] Session not found",
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
    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${tokensParam}`),
    );
    const html = await (response ?? new Response()).text();
    expect(html).toContain("/t/");
    expect(html).toContain(`${a.token}+${b.token}`);
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

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    const html = await (response ?? new Response()).text();
    expect(html).toContain("/t/");
    expect(html).toContain(token);
    // The listing's thank-you URL is resolved and rendered
    expect(html).toContain("https://example.com/alice-thanks");
  });

  test("already-processed direct render after token-clearing redirect shows paid success", async () => {
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
      // First hit: no explicit thank-you URL, so the redirect path runs and
      // clears the stored ticket tokens (line 155).
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      // First hit is a redirect (302), not a direct render
      const firstResponse = first ?? new Response();
      expect(firstResponse.status).toBe(302);
      const redirect = firstResponse.headers.get("location") ?? "";
      expect(redirect).toContain("/payment/success?tokens=");

      // Second hit: tokens are now empty → falls to the direct-render
      // already-processed path (line 172), which resolves the listing's
      // thank-you URL via singleListingThankYou.
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      const secondHtml = await (second ?? new Response()).text();
      // paid: true must be rendered → data-payment-result="success"
      expect(secondHtml).toContain('data-payment-result="success"');
      // The listing's own thank-you URL is used
      expect(secondHtml).toContain('href="https://example.com/listing-thanks"');
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

    const { clearSessionTokens } = await import(
      "#shared/db/processed-payments.ts"
    );
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_explicit",
        metadata: signedMeta(
          {
            email: "bob@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Bob",
            thank_you_url: "https://example.com/explicit-thanks",
          },
          1000,
        ),
        payment_intent: "pi_explicit",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      // First hit: processes and direct-renders with explicit thank-you + tokens
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      const firstHtml = await (first ?? new Response()).text();
      expect(firstHtml).toContain("https://example.com/explicit-thanks");

      // Simulate a webhook racing in and consuming the tokens
      await clearSessionTokens("cs_explicit");

      // Second hit: tokens now empty, but explicit thank-you is still in
      // metadata. The explicit URL must win — not be replaced by the
      // listing's own thank-you URL.
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      const secondHtml = await (second ?? new Response()).text();
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

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    const html = await (response ?? new Response()).text();
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
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_deleted_listing",
        metadata: signedMeta(
          {
            email: "carol@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Carol",
          },
          1000,
        ),
        payment_intent: "pi_deleted_listing",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      // First hit: processes and redirects (clearing tokens)
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      expect((first ?? new Response()).status).toBe(302);

      // Delete the listing between requests
      await deleteListing(listing.id);

      // Second hit: listing gone, tokens cleared; singleListingThankYou
      // returns "" for a deleted listing (no meta-refresh, no redirect link)
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      const secondHtml = await (second ?? new Response()).text();
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

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${encodeURIComponent(tokens)}`),
    );
    const html = await (response ?? new Response()).text();
    // Multiple listings: no single thank-you URL should be picked
    expect(html).not.toContain("https://example.com/thanks-a");
    expect(html).not.toContain("https://example.com/thanks-b");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("returns error for invalid tokens param", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/success?tokens=BOGUS")),
    );
  });
});
