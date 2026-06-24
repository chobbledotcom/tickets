import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { ListingInput } from "#shared/db/listings.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { paymentsApi } from "#shared/payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  assertAdminHtml,
  awaitTestRequest,
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  mockFormRequest,
  mockProviderType,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

// -- URL builders --------------------------------------------------------- //

const refundUrl = (listingId: number, attendeeId: number) =>
  `/admin/listing/${listingId}/attendee/${attendeeId}/refund`;

const refundAllUrl = (listingId: number) =>
  `/admin/listing/${listingId}/refund-all`;

/** POST the refund-all confirmation form for a listing as the owner. */
const postRefundAll = async (listing: {
  id: number;
  name: string;
}): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      refundAllUrl(listing.id),
      { confirm_identifier: listing.name, csrf_token: await testCsrfToken() },
      await testCookie(),
    ),
  );

/** Seed `count` paid attendees with payment-intent ids `${piPrefix}<i>`. */
const seedBatchAttendees = async (
  listing: { id: number },
  piPrefix: string,
  count = 32,
): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await createPaidTestAttendee(
      listing.id,
      `User ${i}`,
      `user${i}@example.com`,
      `${piPrefix}${i}`,
    );
  }
};

/** Assert a refund-all response reporting 1 succeeded + 1 failed. */
const expectPartialRefund = async (
  listing: { id: number },
  response: Response,
): Promise<void> => {
  await expectFlashRedirect(
    `/admin/listing/${listing.id}/refund-all`,
    expect.stringContaining("1 refund(s) succeeded"),
    false,
  )(response);
  expectFlash(response, expect.stringContaining("1 failed"), false);
};

// -- Setup helpers -------------------------------------------------------- //

const createPaidListing = (
  overrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
) => createTestListing({ maxAttendees: 100, unitPrice: 500, ...overrides });

type RefundCtx = {
  listing: Listing;
  attendee: Attendee;
  cookie: string;
  csrfToken: string;
};

/** Create a paid listing + paid John Doe attendee + admin session. */
const setupRefundTest = async (paymentId: string): Promise<RefundCtx> => {
  const listing = await createPaidListing();
  const attendee = await createPaidTestAttendee(
    listing.id,
    "John Doe",
    "john@example.com",
    paymentId,
  );
  return {
    attendee,
    cookie: await testCookie(),
    csrfToken: await testCsrfToken(),
    listing,
  };
};

/** POST the single-attendee refund form. Defaults to John Doe + ctx csrf. */
const submitRefund = (
  { listing, attendee, csrfToken, cookie }: RefundCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundUrl(listing.id, attendee.id),
      { confirm_identifier: "John Doe", csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

/** POST the refund-all form. Defaults to listing name + ctx csrf. */
const submitRefundAll = (
  { listing, csrfToken, cookie }: RefundCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundAllUrl(listing.id),
      { confirm_identifier: listing.name, csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

/**
 * Make a `createPaidTestAttendee` "refunded" the production way: reverse their
 * sole paid booking order in the ledger, which posts the `refund_cash` leg the
 * refunded-status projection reads. `listingId` is unused now that status comes
 * from the ledger, but kept so call sites read as a per-listing refund.
 */
const markAsRefunded = async (attendeeId: number, _listingId: number) => {
  const { recordAttendeeRefund } = await import("#shared/refund-ledger.ts");
  await recordAttendeeRefund(attendeeId);
};

// -- Mock provider helper ------------------------------------------------- //

const withRefundMock = async (
  refundBehavior: boolean | (() => Promise<boolean>),
  fn: (mockRefund: Stub) => Promise<void>,
) => {
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockRefund =
        typeof refundBehavior === "function"
          ? stub(stripePaymentProvider, "refundPayment", refundBehavior)
          : stub(stripePaymentProvider, "refundPayment", () =>
              Promise.resolve(refundBehavior),
            );
      try {
        await fn(mockRefund);
      } finally {
        mockRefund.restore();
      }
    },
  );
};

// -- Tests ---------------------------------------------------------------- //

describeWithEnv("server (admin refunds)", { db: true }, () => {
  describe("GET /admin/listing/:listingId/attendee/:attendeeId/refund", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/refund", {
      setup: async () => {
        const listing = await createPaidListing();
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await awaitTestRequest(refundUrl(999, 1), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie } = await setupListingAndLogin({ maxAttendees: 100 });
      const response = await awaitTestRequest(refundUrl(1, 999), { cookie });
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different listing", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 100,
        name: "Listing 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 100,
        name: "Listing 2",
      });
      const attendee = await createTestAttendee(
        listing2.id,
        listing2.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        refundUrl(listing1.id, attendee.id),
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("shows error when attendee has no payment", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        refundUrl(listing.id, attendee.id),
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 400, "no payment to refund");
    });

    test("shows refund confirmation page for paid attendee", async () => {
      const ctx = await setupRefundTest("pi_test_123");
      const response = await awaitTestRequest(
        refundUrl(ctx.listing.id, ctx.attendee.id),
        { cookie: ctx.cookie },
      );
      await expectHtmlResponse(
        response,
        200,
        "Refund Attendee",
        "John Doe",
        "type their name",
        "£5",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const ctx = await setupRefundTest("pi_test_return");
      const url = `${refundUrl(ctx.listing.id, ctx.attendee.id)}?return_url=${encodeURIComponent(
        "/admin/calendar#attendees",
      )}`;
      await assertAdminHtml(
        url,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/refund", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/refund", {
      body: {
        confirm_identifier: "John Doe",
      },
      method: "POST",
      setup: async () => {
        const listing = await createPaidListing();
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("rejects invalid CSRF token", async () => {
      const ctx = await setupRefundTest("pi_test_456");
      const response = await submitRefund(ctx, { csrf_token: "invalid-token" });
      expect(response.status).toBe(403);
    });

    test("rejects mismatched attendee name", async () => {
      const ctx = await setupRefundTest("pi_test_789");
      const response = await submitRefund(ctx, {
        confirm_identifier: "Wrong Name",
      });
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });

    test("returns error when attendee has no payment", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundUrl(listing.id, attendee.id),
          { confirm_identifier: "John Doe", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/refund`,
        expect.stringContaining("no payment to refund"),
        false,
      )(response);
    });

    test("returns error when no payment provider configured", async () => {
      const ctx = await setupRefundTest("pi_test_noprov");
      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
        expect.stringContaining("No payment provider configured"),
        false,
      )(response);
    });

    test("successfully refunds attendee payment", async () => {
      const ctx = await setupRefundTest("pi_test_success");

      await withRefundMock(true, async (mockRefund) => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/listing/${ctx.listing.id}`,
          "Refund issued",
        )(response);
        expect(mockRefund.calls.length).toBeGreaterThan(0);
      });
    });

    test("shows error when refund fails", async () => {
      const ctx = await setupRefundTest("pi_test_fail");

      await withRefundMock(false, async () => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
          expect.stringContaining("Refund failed"),
          false,
        )(response);
      });
    });

    test("surfaces a provider refund the ledger could not record", async () => {
      // The booking predates the ledger, so the provider refund succeeds but the
      // reversal finds no clean order to post — refund status is ledger-only now,
      // so this must surface for a manual adjustment, not read as refunded.
      const listing = await createPaidListing();
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "John Doe",
        "john@example.com",
        "pi_unrecorded",
      );
      const ctx: RefundCtx = {
        attendee,
        cookie: await testCookie(),
        csrfToken: await testCsrfToken(),
        listing,
      };
      await withRefundMock(true, async (mockRefund) => {
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/refund`,
          expect.stringContaining("could not be recorded"),
          false,
        )(response);
        expect(mockRefund.calls.length).toBeGreaterThan(0);
      });
    });

    test("handles missing confirm_identifier field", async () => {
      const ctx = await setupRefundTest("pi_test_missing");
      const response = await handleRequest(
        mockFormRequest(
          refundUrl(ctx.listing.id, ctx.attendee.id),
          { csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });
  });

  describe("GET /admin/listing/:id/refund-all", () => {
    testRequiresAuth("/admin/listing/1/refund-all", {
      setup: async () => {
        await createPaidListing();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await awaitTestRequest(refundAllUrl(999), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("shows error when no attendees have payments", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        400,
        "No attendees have payments to refund",
      );
    });

    test("shows refund all confirmation page with refundable count", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_paid_1",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Free User",
        "free@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Refund All",
        "1 attendee(s) with payments",
        "type the listing name",
      );
    });
  });

  describe("POST /admin/listing/:id/refund-all", () => {
    // A bulk refund posts a ledger reversal per attendee — a known per-attendee
    // read (an N+1 the dev guard throws on past ~25 rows). Production runs the
    // guard in notify-only mode (src/edge.ts) so a real bulk refund of many
    // attendees still posts every leg; match that here. Batching the bulk ledger
    // work into one round-trip is a tracked follow-up.
    beforeEach(() => setN1GuardNotifyOnly(true));
    afterEach(() => setN1GuardNotifyOnly(null));

    testRequiresAuth("/admin/listing/1/refund-all", {
      body: {
        confirm_identifier: "Test Listing",
      },
      method: "POST",
      setup: async () => {
        await createPaidListing();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(999),
          { confirm_identifier: "Test", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects mismatched listing name", async () => {
      const ctx = await setupRefundTest("pi_refundall_1");
      const response = await submitRefundAll(ctx, {
        confirm_identifier: "Wrong Listing Name",
      });
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });

    test("rejects when confirm_identifier is missing", async () => {
      const ctx = await setupRefundTest("pi_refundall_missing");
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(ctx.listing.id),
          { csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        expect.stringContaining("does not match"),
        false,
      )(response);
    });

    test("returns error when no attendees have payments", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(listing.id),
          {
            confirm_identifier: listing.name,
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/refund-all`,
        expect.stringContaining("No attendees have payments to refund"),
        false,
      )(response);
    });

    test("returns error when no payment provider configured", async () => {
      const ctx = await setupRefundTest("pi_noprov_all");
      const response = await submitRefundAll(ctx);
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/refund-all`,
        expect.stringContaining("No payment provider configured"),
        false,
      )(response);
    });

    test("successfully refunds all attendees", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "User One",
        "one@example.com",
        "pi_all_1",
      );
      await createPaidTestAttendee(
        listing.id,
        "User Two",
        "two@example.com",
        "pi_all_2",
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "All attendees refunded",
        )(response);
        expect(mockRefund.calls.length).toBe(2);
      });
    });

    test("counts a refund the ledger could not record as errored, not refunded", async () => {
      // One clean ledgered booking (its reversal posts) and one that predates the
      // ledger (provider refunds, but the batch can't record it). The unrecorded
      // one is tallied as errored so it surfaces rather than reading as refunded.
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Ledgered",
        "ledgered@example.com",
        "pi_mixed_ledgered",
      );
      await createPaidAttendeeWithoutLedger(
        listing.id,
        "Unledgered",
        "unledgered@example.com",
        "pi_mixed_unledgered",
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(2);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          expect.stringContaining("errored"),
          false,
        )(response);
      });
    });

    test("caps refunds at 30 per request and shows continuation message", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(listing, "pi_batch_");
      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(listing);
        expect(mockRefund.calls.length).toBe(30);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          expect.stringContaining("30 attendee(s) refunded"),
        )(response);
        expectFlash(response, expect.stringContaining("2 remaining"), true);
      });
    });

    test("reports failures with remaining count when batch has errors", async () => {
      const listing = await createPaidListing({ maxAttendees: 500 });
      await seedBatchAttendees(listing, "pi_batchfail_");
      await withRefundMock(false, async () => {
        const response = await postRefundAll(listing);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          expect.stringContaining("30 failed"),
          false,
        )(response);
        expectFlash(response, expect.stringContaining("2 remaining"), false);
      });
    });

    test("reports partial failure when some refunds fail", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Good User",
        "good@example.com",
        "pi_partial_ok",
      );
      await createPaidTestAttendee(
        listing.id,
        "Bad User",
        "bad@example.com",
        "pi_partial_fail",
      );
      let callNum = 0;
      await withRefundMock(
        () => Promise.resolve(++callNum <= 1),
        async () => {
          await expectPartialRefund(listing, await postRefundAll(listing));
        },
      );
    });

    test("catches thrown refund errors and reports them in the flash", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Good User",
        "good@example.com",
        "pi_throw_ok",
      );
      await createPaidTestAttendee(
        listing.id,
        "Throw User",
        "throw@example.com",
        "pi_throw_boom",
      );
      let callNum = 0;
      await withRefundMock(
        () => {
          callNum++;
          if (callNum === 1) return Promise.resolve(true);
          return Promise.reject(new Error("Stripe refund boom"));
        },
        async () => {
          const response = await postRefundAll(listing);
          await expectPartialRefund(listing, response);
          expectFlash(response, expect.stringContaining("1 errored"), false);
        },
      );
    });
  });

  describe("already-refunded guard", () => {
    test("GET refund page shows error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_already_refunded");
      await markAsRefunded(ctx.attendee.id, ctx.listing.id);

      const response = await awaitTestRequest(
        refundUrl(ctx.listing.id, ctx.attendee.id),
        { cookie: ctx.cookie },
      );
      await expectHtmlResponse(response, 400, "already been refunded");
    });

    test("POST refund returns error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_post_already");
      await markAsRefunded(ctx.attendee.id, ctx.listing.id);

      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
        expect.stringContaining("already been refunded"),
        false,
      )(response);
    });

    test("refund-all excludes already-refunded attendees", async () => {
      const listing = await createPaidListing();
      const refundedAttendee = await createPaidTestAttendee(
        listing.id,
        "Refunded",
        "refunded@example.com",
        "pi_ra_1",
      );
      await createPaidTestAttendee(
        listing.id,
        "Not Refunded",
        "notrefunded@example.com",
        "pi_ra_2",
      );
      await markAsRefunded(refundedAttendee.id, listing.id);

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "1 attendee(s) with payments");
    });

    test("marks attendee as refunded after successful refund", async () => {
      const ctx = await setupRefundTest("pi_mark_refund");

      await withRefundMock(true, async () => {
        const response = await submitRefund(ctx);
        expect(response.status).toBe(302);

        // Verify attendee is marked as refunded by trying to refund again
        const retryResponse = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/refund`,
          expect.stringContaining("already been refunded"),
          false,
        )(retryResponse);
      });
    });
  });

  describe("listing page UI", () => {
    /** Create an listing with an attendee and return the admin listing page HTML */
    const getListingPageHtml = async (listingId: number): Promise<string> => {
      const response = await awaitTestRequest(`/admin/listing/${listingId}`, {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      return response.text();
    };

    test("shows the listing-level Refund All on a paid listing", async () => {
      const listing = await createPaidListing();
      await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_ui_1",
      );

      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie: await testCookie(),
      });
      // The per-attendee refund link moved to the attendee edit page; the
      // listing page keeps the listing-wide Refund All action.
      await expectHtmlResponse(response, 200, "Refund All");
    });

    const createAttendeeAndGetHtml = async (
      listing: Awaited<ReturnType<typeof createTestListing>>,
      name: string,
      email: string,
    ) => {
      await createTestAttendee(listing.id, listing.slug, name, email);
      return getListingPageHtml(listing.id);
    };

    test("does not show Refund All for free listings", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const html = await createAttendeeAndGetHtml(
        listing,
        "Free User",
        "free@example.com",
      );
      expect(html).not.toContain("Refund All");
    });

    test("shows the per-attendee Refund action on a paid attendee's edit page", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Paid User",
        "paid@example.com",
        "pi_edit_1",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/refund`,
      );
    });

    test("hides the Refund action but keeps delete/resend when the attendee has no payment", async () => {
      const listing = await createPaidListing();
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "No Payment User",
        "nopay@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/refund`,
      );
      expect(html).toContain(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/delete`,
      );
      expect(html).toContain(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/resend-notification`,
      );
    });
  });
});
