// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import {
  adminAttendeeAction,
  adminFormPost,
  adminListingPage,
  assertAdminHtml,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  mockFormRequest,
  setupAdminTest,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end
import { setupListingAndAttendee } from "./helpers.ts";

/** A listing plus "John Doe" attendee with the thank-you URL set — shared
 *  setup for the checkin auth, 404, and CSRF tests. */
const setupCheckinListingAndAttendee = (): ReturnType<
  typeof setupListingAndAttendee
> =>
  setupListingAndAttendee({
    listing: {
      maxAttendees: 100,
      thankYouUrl: "https://example.com",
    },
  });

describeWithEnv("server (admin attendees) > checkin", { db: true }, () => {
  const checkinAction = adminAttendeeAction("checkin", "listing");

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/checkin", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/checkin", {
      body: {},
      method: "POST",
      setup: async () => {
        await setupCheckinListingAndAttendee();
      },
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await checkinAction({
        csrf_token: "invalid-token",
      })();
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent attendee", async () => {
      await setupCheckinListingAndAttendee();

      const { response } = await adminFormPost(
        "/admin/listing/1/attendee/999/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/attendee/1/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("checks in an attendee and redirects to the roster with a flash", async () => {
      const { response, listing } = await checkinAction({})();
      expectRedirect(response, `/admin/listing/${listing.id}/attendees`);
      expectFlash(response, expect.stringContaining("Checked John Doe in"));

      // The check-in is recorded in the listing activity log.
      const { getListingActivityLog } = await import("#test-utils");
      const log = (await getListingActivityLog(listing.id)).find((l) =>
        l.message.includes("checked in"),
      );
      expect(log).toBeDefined();
    });

    test("redirects to the in-filtered roster when return_filter is set", async () => {
      const { response, listing } = await checkinAction({
        return_filter: "in",
      })();
      expectRedirect(
        response,
        `/admin/listing/${listing.id}/attendees?filter=in`,
      );
    });

    test("redirects to the out-filtered roster when return_filter is out", async () => {
      // Check in first, then check out with return_filter=out
      const { listing, attendee, cookie, csrfToken } = await checkinAction(
        {},
      )();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken, return_filter: "out" },
          cookie,
        ),
      );
      expectRedirect(
        response,
        `/admin/listing/${listing.id}/attendees?filter=out`,
      );
    });

    test("redirects to the unfiltered roster when return_filter is all", async () => {
      const { response, listing } = await checkinAction({
        return_filter: "all",
      })();
      const location = expectRedirect(
        response,
        `/admin/listing/${listing.id}/attendees`,
      );
      expect(location).not.toContain("filter=");
    });

    test("redirects to return_url when provided", async () => {
      const { response } = await checkinAction({
        return_url: "/admin/calendar?date=2026-03-15#attendees",
      })();
      expectRedirect(
        response,
        "/admin/calendar",
        "date=2026-03-15",
        "#attendees",
      );
      expectFlash(response, expect.stringContaining("Checked"));
    });

    test("checks out an already checked-in attendee", async () => {
      // First check in via the curried helper
      const { listing, attendee, cookie, csrfToken } = await checkinAction(
        {},
      )();

      // Then check out
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectFlash(response, expect.stringContaining("Checked John Doe out"));
    });

    test("roster shows Check in button for unchecked attendee", async () => {
      const { response } = await adminListingPage(
        (ctx) => `/admin/listing/${ctx.listing.id}/attendees`,
      )();
      await expectHtmlResponse(response, 200, "Check in", "/checkin");
    });

    test("roster shows Check out button for checked-in attendee", async () => {
      // Check in first, then view the roster tab
      const { listing } = await checkinAction({})();

      await assertAdminHtml(
        `/admin/listing/${listing.id}/attendees`,
        "Check out",
      );
    });
  });

  describe("no-quantity row action guards", () => {
    /** Set up an admin session + attendee whose single line is a quantity-0
     * sentinel, then POST one of its listing-scoped actions. */
    const ghostRowAction = async (
      action: string,
      scope: "listing" | "attendee" = "attendee",
    ): Promise<{ response: Response; listingId: number }> => {
      const ctx = await setupAdminTest();
      await getDb().execute({
        args: [ctx.attendee.id, ctx.listing.id],
        sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
      });
      const response = await handleRequest(
        mockFormRequest(
          scope === "listing"
            ? `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/${action}`
            : `/admin/attendees/${ctx.attendee.id}/${action}`,
          // setupAdminTest creates the attendee as "John Doe"; verified actions
          // (resend/refund) require the exact name in confirm_identifier.
          { confirm_identifier: "John Doe", csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      return { listingId: ctx.listing.id, response };
    };

    test("check-in refuses a no-quantity row and leaves it unchecked", async () => {
      const { response, listingId } = await ghostRowAction(
        "checkin",
        "listing",
      );
      // With no return_url the refusal lands back on the listing page (not an
      // empty redirect), carrying the flash.
      await expectFlashRedirect(
        `/admin/listing/${listingId}`,
        "Cannot check in a no-quantity line",
        false,
      )(response);
      const row = await getDb().execute({
        args: [listingId],
        sql: "SELECT checked_in FROM listing_attendees WHERE listing_id = ?",
      });
      expect(Number(row.rows[0]!.checked_in)).toBe(0);
    });

    test("re-send notification refuses a no-quantity row", async () => {
      const { response } = await ghostRowAction("resend-notification");
      expectFlash(
        response,
        "Cannot re-send a notification for a no-quantity line",
        false,
      );
    });

    test("refund refuses a no-quantity row (no payment to refund)", async () => {
      const { response } = await ghostRowAction("refund");
      // The listing-scoped refund hides on a ghost row rather than refunding a
      // charge from a listing it doesn't belong to.
      expectRedirect(response, "/refund");
      expectFlash(response, expect.stringContaining("no payment"), false);
    });
  });
});
