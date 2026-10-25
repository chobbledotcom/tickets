/** The direct database reads behind the unsent-notification badges and the
 * dashboard count: the shared email-owed rule, the attendee row's resolved
 * flags, and the booking count those surfaces render. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  clearPendingFlagStatement,
  countAttendeesWithPendingFlags,
  emailBadgePendingOrNull,
  listingCollectsEmail,
} from "#db/attendees/notification-flags.ts";
import {
  getAttendeeBookingRowsRaw,
  getAttendeeOrNull,
  getAttendeesPage,
} from "#db/attendees/queries.ts";
import { execute, executeBatch } from "#db/client.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { requireValue } from "#shared/required-value.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendeeWithFlags,
  createMultiBookingAttendee,
  readPendingNotificationFlags,
  setPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The attendee a test booked, read back the way the admin surfaces read
 * their rows: through the shared attendee read that resolves `email_owed`. */
const readAttendeeBack = async (attendeeId: number) =>
  requireValue(
    await getAttendeeOrNull(attendeeId, await getTestPrivateKey()),
    "the booked attendee",
  );

/** Settle both of one attendee's owed sends, the way an accepted send
 * clears its flag. */
const settleBothSends = (attendeeId: number): Promise<unknown> =>
  executeBatch([
    clearPendingFlagStatement("email", [attendeeId]),
    clearPendingFlagStatement("webhooks", [attendeeId]),
  ]);

describeWithEnv(
  "db > attendees > pending notification reads",
  { db: true },
  () => {
    test("counts a booking that owes both sends once", async () => {
      await bookTestAttendeeWithFlags("Both Sends Buyer", 1, 1);

      expect(await countAttendeesWithPendingFlags()).toBe(1);
    });

    test("counts only attendee rows, not a servicing row with its flags up", async () => {
      const { attendee } = await bookTestAttendeeWithFlags(
        "Servicing Flags Buyer",
        1,
        1,
      );

      // No create path raises a servicing row's flags, but the input type
      // permits the combination and a restored backup can carry it. The
      // count and the attendee list must agree on the rows they count.
      await execute("UPDATE attendees SET kind = ? WHERE id = ?", [
        SERVICING_KIND,
        attendee.id,
      ]);

      expect(await countAttendeesWithPendingFlags()).toBe(0);
    });

    test("adds nothing once every send went out", async () => {
      const { attendee } = await bookTestAttendeeWithFlags(
        "Settled Buyer",
        1,
        1,
      );

      await settleBothSends(attendee.id);

      expect(await countAttendeesWithPendingFlags()).toBe(0);
    });

    test("stops counting the email when the listing stops collecting it, and still counts the owed webhooks", async () => {
      const { attendee, listing } = await bookTestAttendeeWithFlags(
        "Lost Email Buyer",
        1,
        1,
      );

      await execute("UPDATE listings SET fields = 'phone' WHERE id = ?", [
        listing.id,
      ]);

      const read = await readAttendeeBack(attendee.id);
      expect(read.email_pending).toBe(1);
      expect(read.email_owed).toBe(0);
      expect(await countAttendeesWithPendingFlags()).toBe(1);
    });

    test("drops an attendee whose last listing is deleted, and keeps their flags", async () => {
      const { attendee, listing } = await bookTestAttendeeWithFlags(
        "Deleted Listing Buyer",
        0,
        1,
      );
      expect(await countAttendeesWithPendingFlags()).toBe(1);

      await deleteListing(listing.id);

      // deleteListing keeps the attendee and the flag no send can settle
      // now. The count still asks for a booking, so it cannot advertise an
      // attendee the list cannot show.
      expect(await readPendingNotificationFlags(attendee.id)).toEqual({
        email: 0,
        webhooks: 1,
      });
      expect(await countAttendeesWithPendingFlags()).toBe(0);
      const page = await getAttendeesPage({
        listingIds: null,
        page: 0,
        sort: "newest",
      });
      const listedIds = page.rows.map((row) => row.id);
      assert(!listedIds.includes(attendee.id));
    });

    test("keeps counting the owed webhooks while another booking survives", async () => {
      const doomed = await createTestListing({ name: "Doomed Webhook Show" });
      const kept = await createTestListing({ name: "Kept Webhook Show" });
      const attendee = await createMultiBookingAttendee(
        "Surviving Buyer",
        "surviving-buyer@example.com",
        [{ listingId: doomed.id }, { listingId: kept.id }],
      );
      await setPendingNotificationFlags(attendee.id, 0, 1);

      await deleteListing(doomed.id);

      expect(await countAttendeesWithPendingFlags()).toBe(1);
    });

    /** Book one attendee owing only the email, store the given padded
     * fields value on its listing, and pin the owed read and the count. A
     * direct edit or a restored backup can leave pad characters at a token
     * edge. The read trims the pad characters there, so the stored token
     * still reads. */
    const paddedStoredFieldsStayOwed = async (
      name: string,
      fields: string,
    ): Promise<void> => {
      const { attendee, listing } = await bookTestAttendeeWithFlags(name, 1, 0);
      await execute("UPDATE listings SET fields = ? WHERE id = ?", [
        fields,
        listing.id,
      ]);

      const read = await readAttendeeBack(attendee.id);
      expect(read.email_owed).toBe(1);
      expect(await countAttendeesWithPendingFlags()).toBe(1);
    };

    test("reads the owed email through a space-padded stored fields value", async () => {
      await paddedStoredFieldsStayOwed("Space Padded Buyer", " email ");
    });

    test("reads the owed email through a non-breaking-space-padded stored fields value", async () => {
      await paddedStoredFieldsStayOwed(
        "Narrow Padded Buyer",
        "\u00a0email\u00a0",
      );
    });

    test("reads the owed email through a repeatedly space-padded stored fields value", async () => {
      await paddedStoredFieldsStayOwed("Wide Padded Buyer", "   email   ");
    });

    test("reads the owed email through mixed space and non-breaking-space padding", async () => {
      await paddedStoredFieldsStayOwed(
        "Mixed Padded Buyer",
        " \u00a0 \u00a0email \u00a0 ",
      );
    });

    test("reads no owed email when the stored fields only name a lookalike field", async () => {
      const { attendee, listing } = await bookTestAttendeeWithFlags(
        "Lookalike Fields Buyer",
        1,
        0,
      );
      await execute("UPDATE listings SET fields = 'emailx' WHERE id = ?", [
        listing.id,
      ]);

      const read = await readAttendeeBack(attendee.id);
      expect(read.email_owed).toBe(0);
      expect(await countAttendeesWithPendingFlags()).toBe(0);

      // The split keeps token edges, so a space inside a token cannot glue
      // a lookalike into "email".
      await execute("UPDATE listings SET fields = 'e mail' WHERE id = ?", [
        listing.id,
      ]);
      const readAfterLookalike = await readAttendeeBack(attendee.id);
      expect(readAfterLookalike.email_owed).toBe(0);
      expect(await countAttendeesWithPendingFlags()).toBe(0);
    });

    test("the email badge needs the flag up and the listing still collecting", () => {
      expect(emailBadgePendingOrNull({ email_owed: 1, email_pending: 1 })).toBe(
        1,
      );
      expect(emailBadgePendingOrNull({ email_owed: 1, email_pending: 2 })).toBe(
        2,
      );
      expect(emailBadgePendingOrNull({ email_owed: 1, email_pending: 0 })).toBe(
        null,
      );
      expect(emailBadgePendingOrNull({ email_owed: 0, email_pending: 1 })).toBe(
        null,
      );
    });

    test("a read that leaves the flags absent never shows the email badge", () => {
      expect(emailBadgePendingOrNull({})).toBe(null);
      expect(emailBadgePendingOrNull({ email_owed: 1 })).toBe(null);
    });

    test("one listing of a person keeps the badge, the other drops it", async () => {
      // One person, two bookings. The Ceilidh collects an email, the Quiz
      // stopped. The same flag sits on the person, so only each row's own
      // listing can decide its badge.
      const collecting = await createTestListing({
        maxAttendees: 10,
        name: "Scoped Ceilidh",
      });
      const stopped = await createTestListing({
        maxAttendees: 10,
        name: "Scoped Quiz",
      });
      await execute("UPDATE listings SET fields = 'phone' WHERE id = ?", [
        stopped.id,
      ]);
      const attendee = await createMultiBookingAttendee(
        "Scoped Buyer",
        "scoped-buyer@example.com",
        [{ listingId: collecting.id }, { listingId: stopped.id }],
      );
      await setPendingNotificationFlags(attendee.id, 1, 0);

      const rows = await getAttendeeBookingRowsRaw(attendee.id);
      const owedByListing = new Map(
        rows.map((row) => [row.listing_id, row.email_owed]),
      );
      expect(owedByListing.get(collecting.id)).toBe(1);
      expect(owedByListing.get(stopped.id)).toBe(0);

      // The attendee-wide read and the count still follow every booking, so
      // the person keeps the notice on their own page and in the count.
      const read = await readAttendeeBack(attendee.id);
      expect(read.email_owed).toBe(1);
      expect(await countAttendeesWithPendingFlags()).toBe(1);
    });

    test("a listing collects an email when its stored fields name one", () => {
      expect(listingCollectsEmail({ fields: "email,phone" })).toBe(true);
      expect(listingCollectsEmail({ fields: "phone" })).toBe(false);
      expect(listingCollectsEmail({ fields: " email , phone" })).toBe(true);
      expect(listingCollectsEmail({ fields: "emailx" })).toBe(false);
      expect(listingCollectsEmail({ fields: "" })).toBe(false);
    });
  },
);
