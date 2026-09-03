import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { clearSessionTokens, reserveSession } from "#db/processed-payments.ts";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deleteTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubPaidCheckout } from "#test-utils/payment-session.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("the paid success redirect", { db: true }, () => {
  const errors = setupErrorSpy();

  const visit = (sessionId: string): Promise<Response> =>
    handlePaymentSuccess(
      new Request(`http://localhost/payment/success?session_id=${sessionId}`),
    );

  test("redirects a paid checkout to its token URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout("cs_paid_redirect", [
      { e: listing.id, p: 500, q: 1 },
    ]);

    const response = await visit("cs_paid_redirect");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/payment\/success\?tokens=/,
    );
  });

  test("renders the paid page with the intent's thank-you URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout(
      "cs_paid_direct",
      [{ e: listing.id, p: 500, q: 1 }],
      { thank_you_url: "https://example.com/parent-thanks" },
    );

    const response = await visit("cs_paid_direct");

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).toContain("https://example.com/parent-thanks");
    expect(page).toContain('href="/t/');
  });

  test("replays an already-processed checkout from the listing's thank-you URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout("cs_paid_replay", [
      { e: listing.id, p: 500, q: 1 },
    ]);

    expect((await visit("cs_paid_replay")).status).toBe(302);
    const replay = await visit("cs_paid_replay");

    expect(replay.status).toBe(200);
    const page = await replay.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).toContain("url=https://example.com/listing-thanks");
  });

  test("keeps the intent's thank-you URL when a single-listing replay recomputes", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout(
      "cs_paid_parent_replay",
      [{ e: listing.id, p: 500, q: 1 }],
      { thank_you_url: "https://example.com/parent-thanks" },
    );

    // The first visit renders directly, so its token stays on the session;
    // the redirect path is what consumes it, so consume it the same way.
    expect((await visit("cs_paid_parent_replay")).status).toBe(200);
    await clearSessionTokens("cs_paid_parent_replay");
    const replay = await visit("cs_paid_parent_replay");

    const page = await replay.text();
    expect(page).toContain("url=https://example.com/parent-thanks");
    expect(page).not.toContain("listing-thanks");
  });

  test("renders a replay without a thank-you URL when the listing was deleted", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/gone-thanks",
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout("cs_paid_deleted", [
      { e: listing.id, p: 500, q: 1 },
    ]);

    expect((await visit("cs_paid_deleted")).status).toBe(302);
    await deleteTestListing(listing);
    const replay = await visit("cs_paid_deleted");

    expect(replay.status).toBe(200);
    const page = await replay.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).not.toContain("gone-thanks");
    expect(page).not.toContain('http-equiv="refresh"');
  });

  test("accepts Square's orderId redirect parameter", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout("cs_order_paid", [
      { e: listing.id, p: 500, q: 1 },
    ]);

    const response = await handlePaymentSuccess(
      new Request("http://localhost/payment/success?orderId=cs_order_paid"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/payment\/success\?tokens=/,
    );
  });

  test("logs the booked listing when the checkout is mid-flight", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    // Another delivery holds the fresh reservation, so this one answers 409.
    await reserveSession("cs_paid_inflight");
    using _provider = await stubPaidCheckout("cs_paid_inflight", [
      { e: listing.id, p: 500, q: 1 },
    ]);

    const response = await visit("cs_paid_inflight");

    expect(response.status).toBe(409);
    expect(errors.contains(`listing=${listing.id}`)).toBe(true);
  });
});
