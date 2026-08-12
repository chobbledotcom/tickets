import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { confirmRefund } from "#routes/admin/refunds/confirmation.ts";
import { queryOne } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  releaseClaimRows,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  refundReferencesFor,
} from "#test-utils/processed-payments.ts";
import { withTestSession } from "#test-utils/session.ts";

const setup = async () => {
  const sessionId = "sess-confirm-refund";
  const paymentReference = "pi_confirm_refund";
  const attendeeId = await bookedWithPayment(sessionId, paymentReference);
  const privateKey = await getTestPrivateKey();
  const [reference] = (await refundReferencesFor(attendeeId, privateKey)) ?? [];
  if (reference?.kind !== "tagged") {
    throw new Error("the tagged payment reference was not found");
  }
  const claimed = await claimCurrentAttendeeRows([attendeeId], "keyed");
  if (claimed.kind !== "claimed") throw new Error("the claim was refused");
  const booking = await queryOne<{ listing_id: number }>(
    `SELECT listingAttendee.listing_id
       FROM listing_attendees AS listingAttendee
      WHERE listingAttendee.attendee_id = ?`,
    [attendeeId],
  );
  if (booking === null) throw new Error("the attendee booking was not found");
  return {
    attendee: { id: attendeeId, name: "Buyer" },
    claim: { held: claimed.held, heldSince: claimed.heldSince },
    listingId: booking.listing_id,
    paymentOnly: true,
    privateKey,
    reference,
    sessionId,
  };
};

describeWithEnv("admin refunds > confirmation", { db: true }, () => {
  test("rejects a confirmation with no returned payment", async () => {
    const refund = await setup();

    await expect(
      withTestSession(() => confirmRefund({ ...refund, references: [] })),
    ).rejects.toThrow("A refund confirmation needs at least one payment");
  });

  test("writes activity and note cleanup once for one reference set", async () => {
    const refund = await setup();
    const target = attendeeNotes(refund.attendee.id);
    await createSystemNote(
      target,
      `This booking could NOT be refunded automatically. Payment reference: ${refund.reference.reference}.`,
    );
    await createSystemNote(
      target,
      "A different payment could NOT be refunded automatically. Payment reference: pi_other.",
    );

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");
    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("current");

    const activities = await getAttendeeActivityLog(refund.attendee.id);
    expect(
      activities.filter((entry) =>
        entry.message.includes("Payment marked as refunded"),
      ),
    ).toHaveLength(1);
    const notes = await getNotesFor(target, refund.privateKey);
    expect(
      notes.filter((note) => note.note.includes("Refund confirmed")),
    ).toHaveLength(1);
    expect(notes.some((note) => note.note.includes("pi_other"))).toBe(true);
    expect(
      notes.some((note) => note.note.includes(refund.reference.reference)),
    ).toBe(false);
  });

  test("writes nothing after the exact claim has gone", async () => {
    const refund = await setup();
    await releaseClaimRows(refund.claim, [refund.sessionId]);

    await expect(
      withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).rejects.toThrow("Refund confirmation no longer owns every payment row");
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
    expect(
      await getNotesFor(attendeeNotes(refund.attendee.id), refund.privateKey),
    ).toEqual([]);
  });
});
