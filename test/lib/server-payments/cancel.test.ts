// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getCheckoutStageOrNull } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { johnCheckoutSession } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { stageTestCheckout } from "#test-utils/db-helpers/processed-payments.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { makeParent } from "#test-utils/parents.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** A cancelled (unpaid) checkout session for the given id and items metadata —
 *  the shape every /payment/cancel test stubs, differing only in the id and
 *  which listing/package ids the items carry. */
const cancelSession = (sessionId: string, items: string) =>
  johnCheckoutSession(sessionId, { items, paid: false });

/** Run the cancel request for a session and expect the page to answer 200. */
const requestCancel = async (
  listingId: number,
  sessionId: string,
): Promise<void> => {
  await withMocks(
    () => cancelSession(sessionId, singleItem(listingId, 1, 1000)),
    async () => {
      const response = await handleRequest(
        mockRequest(`/payment/cancel?session_id=${sessionId}`),
      );
      expect(response.status).toBe(200);
    },
    resetStripeClient,
  );
};

/** A staged checkout ready to cancel: its listing and its staged row. */
const stageForCancel = async (sessionId: string) => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 1000,
  });
  return { listing, stage: await stageTestCheckout(sessionId, listing) };
};

/** Record calls to the provider's session-expire hook. */
const stubExpire = () =>
  stub(stripeApi, "expireCheckoutSession", () => Promise.resolve());

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve(null),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_invalid"),
          );
          await expectHtmlResponse(response, 400, "Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error for invalid session metadata", async () => {
      await setupStripe();

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {}, // Missing required fields
            paymentIntent: null,
            paymentStatus: "unpaid",
            sessionId: "cs_test_cancel",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          // Provider returns null for invalid metadata, so routes report "not found"
          await expectHtmlResponse(response, 400, "Payment session not found");
        },
        resetStripeClient,
      );
    });

    test("returns error when listing not found", async () => {
      await setupStripe();

      await withMocks(
        // Non-existent listing.
        () => cancelSession("cs_test_cancel", singleItem(99999, 1, 0)),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          await expectHtmlResponse(response, 404, "Listing not found");
        },
        resetStripeClient,
      );
    });

    test("shows cancel page with link back to ticket form", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () => cancelSession("cs_test_cancel", singleItem(listing.id, 1, 1000)),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_test_cancel",
            "Payment Cancelled",
            `/ticket/${listing.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("removes the unpaid staged attendee", async () => {
      await setupStripe();
      const sessionId = "cs_staged_cancel";
      const { listing, stage } = await stageForCancel(sessionId);

      await requestCancel(listing.id, sessionId);

      expect(await getCheckoutStageOrNull(sessionId)).toBeNull();
      const attendee = await getDb().execute({
        args: [stage.attendeeId],
        sql: "SELECT id FROM attendees WHERE id = ?",
      });
      expect(attendee.rows).toEqual([]);
    });

    test("closes the provider session after discarding the stage", async () => {
      await setupStripe();
      const sessionId = "cs_staged_cancel_expire";
      const { listing } = await stageForCancel(sessionId);
      using expire = stubExpire();

      await requestCancel(listing.id, sessionId);
      // The staged details are gone, so the hosted page is closed too — an
      // old tab can no longer pay for a checkout we no longer hold.
      expect(expire.calls.map((call) => call.args)).toEqual([[sessionId]]);
    });

    test("leaves the provider session open when nothing was discarded", async () => {
      await setupStripe();
      const sessionId = "cs_staged_cancel_claimed";
      const { listing } = await stageForCancel(sessionId);
      // A payment request has claimed the session: the discard is refused, so
      // the hosted page must stay open for that payment to finish.
      await reserveSession(sessionId);
      using expire = stubExpire();

      await requestCancel(listing.id, sessionId);
      expect(expire.calls.length).toBe(0);
    });

    test("a cancelled checkout for a now-non-standalone child suppresses the retry link", async () => {
      await setupStripe();

      // The child had its own page when checkout began; it is a plain
      // (non-standalone) child now, so /ticket/<child> 404s and the cancel page
      // must offer a way home instead of a dead retry link.
      const { child } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
      });

      await withMocks(
        () => cancelSession("cs_cancel_child", singleItem(child.id, 1, 1000)),
        async () => {
          const html = await assertPublicHtml(
            "/payment/cancel?session_id=cs_cancel_child",
            "Payment Cancelled",
            "Return home",
          );
          expect(html).not.toContain(`/ticket/${child.slug}`);
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout links back to the package page", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Cancel Pkg",
        slug: "cancel-pkg",
      });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          cancelSession(
            "cs_pkg_cancel",
            JSON.stringify([
              { e: member.id, k: "p", p: 1000, q: 1, r: group.id },
            ]),
          ),
        async () => {
          // The retry link is the bundle's page, not the member's standalone page.
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel",
            "Payment Cancelled",
            `/ticket/${group.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout falls back to the member page when the bundle is no longer bookable", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Dead Bundle",
        slug: "dead-bundle",
      });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 1000,
      });
      // A package is all-or-nothing; deactivating a second member leaves the
      // bundle incomplete, so /ticket/<group> now 404s. The retry link must fall
      // back to the still-standalone member page rather than the dead bundle.
      const gone = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await getDb().execute({
        args: [gone.id],
        sql: "UPDATE listings SET active = 0 WHERE id = ?",
      });

      await withMocks(
        () =>
          cancelSession(
            "cs_pkg_cancel_dead",
            JSON.stringify([
              { e: member.id, k: "p", p: 1000, q: 1, r: group.id },
            ]),
          ),
        async () => {
          const html = await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel_dead",
            "Payment Cancelled",
            `/ticket/${member.slug}`,
          );
          expect(html).not.toContain(`/ticket/${group.slug}`);
        },
        resetStripeClient,
      );
    });

    test("a cancelled package checkout falls back to the member page when the group is gone", async () => {
      await setupStripe();

      const member = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          cancelSession(
            "cs_pkg_cancel_gone",
            JSON.stringify([{ e: member.id, k: "p", p: 1000, q: 1, r: 99999 }]),
          ),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_pkg_cancel_gone",
            "Payment Cancelled",
            `/ticket/${member.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("shows cancel page for ticket session", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 2000,
      });

      await withMocks(
        () =>
          cancelSession(
            "cs_test_cancel_multi",
            JSON.stringify([
              { e: listing.id, p: 1000, q: 1 },
              { e: listing2.id, p: 4000, q: 2 },
            ]),
          ),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_test_cancel_multi",
            "Payment Cancelled",
            `/ticket/${listing.slug}`,
          );
        },
        resetStripeClient,
      );
    });

    test("returns 404 for ticket session with invalid items", async () => {
      await setupStripe();

      await withMocks(
        // Empty items array.
        () => cancelSession("cs_test_cancel_bad_multi", "[]"),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel_bad_multi"),
          );
          await expectHtmlResponse(response, 404, "Listing not found");
        },
        resetStripeClient,
      );
    });

    test("returns 404 for ticket session with unparseable items", async () => {
      await setupStripe();

      await withMocks(
        // Unparseable JSON → parseBookingItems null.
        () => cancelSession("cs_test_cancel_unparseable", "not-json"),
        async () => {
          const response = await handleRequest(
            mockRequest(
              "/payment/cancel?session_id=cs_test_cancel_unparseable",
            ),
          );
          await expectHtmlResponse(response, 404, "Listing not found");
        },
        resetStripeClient,
      );
    });
  });
});
