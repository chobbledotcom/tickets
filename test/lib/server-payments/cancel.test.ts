// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
  stubRetrieveCheckoutSession({
    amountTotal: 0,
    metadata: { email: "john@example.com", items, name: "John" },
    paymentIntent: null,
    paymentStatus: "unpaid",
    sessionId,
  });

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
