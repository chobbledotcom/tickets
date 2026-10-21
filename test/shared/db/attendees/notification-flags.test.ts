/** The direct database reads behind the unsent-notification badges and the
 * dashboard count: the shared email-owed rule, the attendee row's resolved
 * flags, and the booking count those surfaces render. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  clearPendingFlagStatement,
  countAttendeesWithPendingFlags,
  emailBadgeOwed,
} from "#db/attendees/notification-flags.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { execute, executeBatch } from "#db/client.ts";
import { requireValue } from "#shared/required-value.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";

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

    /** Book one attendee owing only the email, store the given padded
     * fields value on its listing, and pin the owed read and the count. A
     * direct edit or a restored backup can leave pad characters at a token
     * edge. The read folds one pad character there, so the stored token
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
    });

    test("the email badge needs the flag up and the listing still collecting", () => {
      expect(emailBadgeOwed({ email_owed: 1, email_pending: 1 })).toBe(true);
      expect(emailBadgeOwed({ email_owed: 1, email_pending: 2 })).toBe(true);
      expect(emailBadgeOwed({ email_owed: 1, email_pending: 0 })).toBe(false);
      expect(emailBadgeOwed({ email_owed: 0, email_pending: 1 })).toBe(false);
    });
  },
);
