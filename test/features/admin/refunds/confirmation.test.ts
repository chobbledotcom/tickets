import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { confirmRefund } from "#routes/admin/refunds/confirmation.ts";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { releaseClaimRows } from "#test-utils/payment-claim.ts";
import { withTestSession } from "#test-utils/session.ts";
import {
  confirmationCount,
  confirmFixturePaymentAndReplay,
  DEFAULT_PAYMENT,
  setupConfirmation as setup,
} from "./confirmation-fixture.ts";

describeWithEnv("admin refunds > confirmation", { db: true }, () => {
  test("rejects a confirmation with no returned payment", async () => {
    const refund = await setup();

    await expect(
      withTestSession(() => confirmRefund({ ...refund, references: [] })),
    ).rejects.toThrow("A refund confirmation needs at least one payment");
  });

  test("rejects a returned payment with no blind identity", async () => {
    const refund = await setup();

    await expect(
      withTestSession(() =>
        confirmRefund({
          ...refund,
          references: [{ ...refund.reference, index: "" }],
        })
      ),
    ).rejects.toThrow("A refund confirmation needs indexed payment references");

    expect(await confirmationCount(refund.attendee.id)).toBe(0);
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
  });

  test("writes activity and one confirmation for one reference set", async () => {
    const refund = await setup();
    const target = attendeeNotes(refund.attendee.id);
    await createSystemNote(target, "A separate historical payment note.");

    expect(await confirmFixturePaymentAndReplay(refund)).toEqual([
      "new",
      "current",
    ]);

    const activities = await getAttendeeActivityLog(refund.attendee.id);
    const confirmations = activities.filter((entry) =>
      entry.message.includes("Payment marked as refunded")
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.message).not.toContain(refund.attendeeName);
    expect(confirmations[0]?.message).not.toContain(refund.reference.reference);
    const notes = await getNotesFor(target, refund.privateKey);
    expect(
      notes.filter((note) => note.note.includes("Refund confirmed")),
    ).toHaveLength(1);
    expect(
      notes.some((note) => note.note.includes("separate historical")),
    ).toBe(true);
    expect(await confirmationCount(refund.attendee.id)).toBe(1);
    const stored = await queryOne<{ identity: string }>(
      `SELECT confirmation.identity
         FROM refund_confirmations AS confirmation
        WHERE confirmation.attendee_id = ?`,
      [refund.attendee.id],
    );
    if (stored === null) throw new Error("the confirmation was not stored");
    expect(stored.identity).not.toContain(refund.reference.reference);
  });

  test("serialises concurrent replay and canonicalises duplicate references", async () => {
    const refund = await setup([
      DEFAULT_PAYMENT,
      {
        paymentReference: "pi_confirm_refund_second",
        sessionId: "sess-confirm-refund-second",
      },
    ]);
    const [first, second] = refund.references;
    if (first === undefined || second === undefined) {
      throw new Error("two refund references were not found");
    }

    const results = await Promise.all([
      withTestSession(() =>
        confirmRefund({
          ...refund,
          references: [second, first, second],
        })
      ),
      withTestSession(() =>
        confirmRefund({ ...refund, references: [first, second] })
      ),
    ]);

    expect(results.sort()).toEqual(["current", "new"]);
    expect(await confirmationCount(refund.attendee.id)).toBe(1);
    expect(
      await queryAll<{ reference_index: string }>(
        `SELECT reference.reference_index
           FROM refund_confirmation_references AS reference
           JOIN refund_confirmations AS confirmation
             ON confirmation.identity = reference.confirmation_identity
          WHERE confirmation.attendee_id = ?
          ORDER BY reference.reference_index`,
        [refund.attendee.id],
      ),
    ).toEqual(
      refund.references
        .map((reference) => ({
          reference_index: reference.index,
        }))
        .sort((left, right) =>
          left.reference_index.localeCompare(right.reference_index)
        ),
    );
    expect(
      (await getAttendeeActivityLog(refund.attendee.id)).filter((entry) =>
        entry.message.includes("Payment marked as refunded")
      ),
    ).toHaveLength(1);
    expect(
      (
        await getNotesFor(attendeeNotes(refund.attendee.id), refund.privateKey)
      ).filter((note) => note.note.includes("Refund confirmed")),
    ).toHaveLength(1);
  });

  test("rolls the replay identity and every visible effect back together", async () => {
    const refund = await setup();
    await execute(
      `CREATE TRIGGER fail_refund_confirmation_activity
       BEFORE INSERT ON activity_log
       BEGIN
         SELECT RAISE(ABORT, 'activity write failed');
       END`,
    );

    await expect(
      withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] })
      ),
    ).rejects.toThrow("activity write failed");

    expect(await confirmationCount(refund.attendee.id)).toBe(0);
    expect(
      await queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM refund_confirmation_references",
      ),
    ).toEqual({ count: 0 });
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
    expect(
      await getNotesFor(
        attendeeNotes(refund.attendee.id),
        refund.privateKey,
      ),
    ).toEqual([]);
  });

  test("writes nothing after the exact claim has gone", async () => {
    const refund = await setup();
    await releaseClaimRows(refund.claim, [refund.sessionId]);

    await expect(
      withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] })
      ),
    ).rejects.toThrow("Refund confirmation no longer owns every payment row");
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
    expect(
      await getNotesFor(attendeeNotes(refund.attendee.id), refund.privateKey),
    ).toEqual([]);
  });

  test("does not open unrelated history for a current payment", async () => {
    const refund = await setup();
    await execute(
      `INSERT INTO activity_log
         (created, listing_id, attendee_id, message)
       VALUES (?, ?, ?, ?)`,
      [
        "2026-08-01T00:00:00.000Z",
        refund.listingId,
        refund.attendee.id,
        "not encrypted activity",
      ],
    );
    await execute(
      `INSERT INTO system_notes
         (created, entity_type, entity_id, type, note)
       VALUES (?, 'attendee', ?, 'system', ?)`,
      ["2026-08-01T00:00:00.000Z", refund.attendee.id, "not encrypted note"],
    );

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] })
      ),
    ).toBe("new");

    const activityCount = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM activity_log AS activity
        WHERE activity.attendee_id = ?`,
      [refund.attendee.id],
    );
    if (activityCount === null) {
      throw new Error("the attendee activity count was not found");
    }
    expect(activityCount.count).toBe(2);
  });
});
