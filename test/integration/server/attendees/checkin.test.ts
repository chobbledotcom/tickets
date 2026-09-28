// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { handleRequest } from "#routes";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
// jscpd:ignore-end
import {
  adminAttendeeAction,
  adminListingPage,
  setupAdminTest,
} from "#test-utils/admin-fixture.ts";
import {
  assertAdminHtml,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import {
  brunoOnTwoListings,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import type { Attendee, Listing } from "#types";

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

  /** Check "John Doe" in via the curried helper, then POST the checkin route
   * again with the direction the roster's Check Out button sends, plus any
   * extra body fields. Returns that second response and the listing. */
  const checkInThenPost = async (body: Record<string, string> = {}) => {
    const { listing, attendee, cookie, csrfToken } = await checkinAction({
      check_in: "true",
    })();
    const response = await handleRequest(
      mockFormRequest(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "false", csrf_token: csrfToken, ...body },
        cookie,
      ),
    );
    return { listing, response };
  };

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
      const { response, listing } = await checkinAction({
        check_in: "true",
      })();
      expectRedirect(response, `/admin/listing/${listing.id}/attendees`);
      expectFlash(response, expect.stringContaining("Checked John Doe in"));

      // The check-in is recorded in the listing activity log.
      const log = (await getListingActivityLog(listing.id)).find((l) =>
        l.message.includes("checked in"),
      );
      expect(log).toBeDefined();
    });

    // Regression: the paired load used to read the attendee's first booking
    // line and 404 when it belonged to another listing, so pressing Check in
    // on the roster sent the operator to the 404 page.
    test("checks in a booking whose attendee also booked another listing", async () => {
      const { attendee, other } = await brunoOnTwoListings(true);

      const { response } = await adminFormPost(
        `/admin/listing/${other.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true" },
      );
      expectRedirect(response, `/admin/listing/${other.id}/attendees`);
      expectFlash(response, expect.stringContaining("Checked Bruno in"));
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
      const { response, listing } = await checkInThenPost({
        return_filter: "out",
      });
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
        check_in: "true",
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
      // First check in via the curried helper, then a second POST checks out.
      const { response } = await checkInThenPost();
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
      const { listing } = await checkinAction({ check_in: "true" })();

      await assertAdminHtml(
        `/admin/listing/${listing.id}/attendees`,
        "Check out",
      );
    });
  });

  describe("the quantity page a multi-ticket line opens", () => {
    /** A listing plus one attendee holding three places on it. */
    const threePlaceAttendee = async (): Promise<{
      attendee: Attendee;
      listing: Listing;
    }> => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createMultiBookingAttendee(
        "Cara Party",
        "cara@example.com",
        [{ listingId: listing.id, quantity: 3 }],
      );
      return { attendee, listing };
    };

    /** The count the line now stores. */
    const storedCount = async (
      listingId: number,
      attendeeId: number,
    ): Promise<number> =>
      Number(
        (
          await getDb().execute(
            "SELECT checked_in FROM listing_attendees WHERE listing_id = ? AND attendee_id = ?",
            [listingId, attendeeId],
          )
        ).rows[0]!.checked_in,
      );

    test("offers 1 to the whole line, and no way out yet", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      const response = await adminGet(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
      );
      const html = await expectHtmlResponse(response, 200, "Check in tickets");
      // The line's state, the three options, the whole line selected, and no
      // release form while nothing is admitted.
      expect(html).toContain(`Cara Party, ${listing.name}`);
      expect(html).toContain("Tickets to check in");
      expect(html).toContain(`<option selected value="3">3 tickets`);
      for (const option of ["1 ticket", "2 tickets", "3 tickets"]) {
        expect(html).toContain(`>${option}</option>`);
      }
      expect(html).not.toContain("Tickets to check out");
    });

    test("offers both directions once part of the line is in", async () => {
      const { attendee, listing } = await threePlaceAttendee();
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true", quantity: "1" },
      );

      const response = await adminGet(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
      );
      const html = await expectHtmlResponse(response, 200, "Check in tickets");
      expect(html).toContain("1 of 3 tickets checked in");
      // The check-in select tops out at the two still owed; the release
      // select holds the one admitted place.
      expect(html).toContain('<option selected value="2">2 tickets');
      expect(html).toContain("Tickets to check out");
      expect(html).toContain('<option selected value="1">1 ticket');
    });

    test("admits the count the page names", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true", quantity: "2" },
      );
      expectFlash(
        response,
        expect.stringContaining("Checked Cara Party in (2 tickets)"),
      );
      expect(await storedCount(listing.id, attendee.id)).toBe(2);
      const messages = (await getListingActivityLog(listing.id))
        .map((entry) => entry.message)
        .join(" ");
      expect(messages).toContain("checked in 2 tickets");
    });

    test("releases the count the page names", async () => {
      const { attendee, listing } = await threePlaceAttendee();
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true" },
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "false", quantity: "2" },
      );
      expectFlash(
        response,
        expect.stringContaining("Checked Cara Party out (2 tickets)"),
      );
      expect(await storedCount(listing.id, attendee.id)).toBe(1);
    });

    test("a fully admitted line offers only the way out", async () => {
      const { attendee, listing } = await threePlaceAttendee();
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true" },
      );

      const response = await adminGet(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
      );
      const html = await expectHtmlResponse(response, 200, "Check out tickets");
      expect(html).toContain("3 of 3 tickets checked in");
      expect(html).not.toContain("Tickets to check in");
      expect(html).toContain("Tickets to check out");
      expect(html).toContain('<option selected value="3">3 tickets');
    });

    test("refuses a count that is not a positive whole number", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true", quantity: "two" },
      );
      expectFlash(response, "Invalid ticket count", false);
      expect(await storedCount(listing.id, attendee.id)).toBe(0);
    });

    test("refuses a count with anything after its digits", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      for (const quantity of ["2tickets", "1.5", "1e2"]) {
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          { check_in: "true", quantity },
        );
        expectFlash(response, "Invalid ticket count", false);
      }
      expect(await storedCount(listing.id, attendee.id)).toBe(0);
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
