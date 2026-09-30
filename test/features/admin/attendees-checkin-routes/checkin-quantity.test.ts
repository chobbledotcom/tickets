// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { getListingActivityLog } from "#test-utils/activity-log.ts";
import { expectFlash, expectHtmlResponse } from "#test-utils/assertions.ts";
import { bookRefundedSibling } from "#test-utils/attendees/refunded-sibling.ts";
// jscpd:ignore-end
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import type { Attendee, Listing } from "#types";

describeWithEnv("server (admin attendees) > checkin", { db: true }, () => {
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

    test("keeps the roster's filter and return link on its forms", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      const html = await expectHtmlResponse(
        await adminGet(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin` +
            "?return_filter=out&return_url=%2Fadmin%2Fcalendar",
        ),
        200,
      );
      expect(html).toContain(
        '<input name="return_filter" type="hidden" value="out">',
      );
      expect(html).toContain(
        '<input name="return_url" type="hidden" value="/admin/calendar">',
      );
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

    test("totals only the rows a refund has not returned", async () => {
      // A person merged from two bookings on one listing holds two rows:
      // the dual-path shape a package booking and a standalone booking
      // make. Reverse the order the package row rides, and the page must
      // total the standalone row alone.
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const group = await createTestGroup({
        isPackage: true,
        name: "RefundKit",
      });
      const attendee = await bookRefundedSibling(
        listing.id,
        group.id,
        "Cara Merged",
        "cara-merged@example.com",
      );

      const response = await adminGet(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
      );
      const html = await expectHtmlResponse(response, 200, "Check in tickets");
      // The refunded sibling holds no movable tickets, so the page totals
      // the live row alone: one owed, and no offer the write cannot apply.
      expect(html).toContain("0 of 1 tickets checked in");
      expect(html).toContain('<option selected value="1">1 ticket');
      expect(html).not.toContain('value="3"');
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
        { check_in: "true", quantity: "3" },
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
        { check_in: "true", quantity: "3" },
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

    test("refuses a post that names no count", async () => {
      const { attendee, listing } = await threePlaceAttendee();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        { check_in: "true" },
      );
      expectFlash(response, "Invalid ticket count", false);
      expect(await storedCount(listing.id, attendee.id)).toBe(0);
    });
  });
});
