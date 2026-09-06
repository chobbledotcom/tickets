import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { clearSessionTokens, reserveSession } from "#db/processed-payments.ts";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
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

  test("hides an explicit thank-you URL for a concealing package", async () => {
    await setupStripe();
    const group = await createHiddenPackageGroup("Private route package");
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 500,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 500 },
    ]);
    using _provider = await stubPaidCheckout(
      "cs_paid_private_thanks",
      [{ e: listing.id, k: "p", p: 500, q: 1, r: group.id }],
      { thank_you_url: "https://example.com/private-member-thanks" },
    );

    const response = await visit("cs_paid_private_thanks");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/payment\/success\?tokens=/,
    );
  });

  for (const explicit of [false, true]) {
    test(`keeps a mixed order's thank-you URL on replay (explicit: ${explicit})`, async () => {
      await setupStripe();
      const group = await createHiddenPackageGroup("Mixed route package");
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        thankYouUrl: "https://example.com/mixed-thanks",
        unitPrice: 500,
      });
      const sessionId = `cs_paid_mixed_${explicit}`;
      using _provider = await stubPaidCheckout(
        sessionId,
        [
          { e: listing.id, k: "p", p: 500, q: 1, r: group.id },
          { e: listing.id, p: 500, q: 1 },
        ],
        explicit ? { thank_you_url: listing.thank_you_url } : {},
      );

      const first = await visit(sessionId);
      expect(first.status).toBe(explicit ? 200 : 302);
      if (explicit) {
        expect(await first.text()).toContain(
          "url=https://example.com/mixed-thanks",
        );
      }
      await clearSessionTokens(sessionId);
      const replay = await visit(sessionId);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain(
        "url=https://example.com/mixed-thanks",
      );
    });
  }

  test("a folded child cannot reveal a concealed parent's explicit URL", async () => {
    await setupStripe();
    const group = await createHiddenPackageGroup("Parent package");
    const parent = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 500,
    });
    const child = await createTestListing({ maxAttendees: 50, unitPrice: 300 });
    await listingChildren.setIds(parent.id, [child.id]);
    using _provider = await stubPaidCheckout(
      "cs_concealed_parent",
      [
        { e: parent.id, k: "p", p: 500, q: 1, r: group.id },
        { e: child.id, p: 300, q: 1 },
      ],
      {
        allocations: JSON.stringify([
          { childId: child.id, parentId: parent.id, qty: 1 },
        ]),
        thank_you_url: "https://example.com/concealed-parent",
      },
    );

    const response = await visit("cs_concealed_parent");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/payment\/success\?tokens=/,
    );
  });

  test("replays several listings without a thank-you redirect", async () => {
    await setupStripe();
    const first = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    const second = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    using _provider = await stubPaidCheckout("cs_paid_many_replay", [
      { e: first.id, p: 500, q: 1 },
      { e: second.id, p: 500, q: 1 },
    ]);

    expect((await visit("cs_paid_many_replay")).status).toBe(302);
    const replay = await visit("cs_paid_many_replay");

    expect(replay.status).toBe(200);
    const page = await replay.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).not.toContain('http-equiv="refresh"');
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
