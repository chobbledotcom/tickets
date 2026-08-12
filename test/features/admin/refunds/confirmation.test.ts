import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { confirmRefund } from "#routes/admin/refunds/confirmation.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  createNamedSystemNote,
  createSystemNote,
  getNotesFor,
} from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  releaseClaimRows,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
  refundReferencesFor,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { withTestSession } from "#test-utils/session.ts";

type PaymentFixture = { paymentReference: string; sessionId: string };

const DEFAULT_PAYMENT: PaymentFixture = {
  paymentReference: "pi_confirm_refund",
  sessionId: "sess-confirm-refund",
};

const setup = async (
  payments: readonly PaymentFixture[] = [DEFAULT_PAYMENT],
) => {
  const [first, ...later] = payments;
  if (first === undefined) {
    throw new Error("confirmation setup needs a payment");
  }
  const attendeeId = await bookedWithPayment(
    first.sessionId,
    first.paymentReference,
  );
  await Promise.all(
    later.map((payment) =>
      finalizeProcessedPayment(
        payment.sessionId,
        attendeeId,
        `tok-${payment.sessionId}`,
        taggedPaymentReference(payment.paymentReference),
      ),
    ),
  );
  const privateKey = await getTestPrivateKey();
  const loaded = await refundReferencesFor(attendeeId, privateKey);
  if (loaded === undefined) throw new Error("payment references were omitted");
  const references = loaded.map((reference) => {
    if (reference.kind !== "tagged") {
      throw new Error("an untagged payment reference was loaded");
    }
    return reference;
  });
  const [reference] = references;
  if (reference === undefined) {
    throw new Error("no payment reference was found");
  }
  const claimed = await claimCurrentAttendeeRows([attendeeId]);
  if (claimed.kind !== "claimed") throw new Error("the claim was refused");
  const claim = {
    commandId: claimed.commandId,
    held: claimed.held,
    heldSince: claimed.heldSince,
    phases: new Map(
      [...claimed.phases].map(([sessionId]) => [
        sessionId,
        "ready" as const,
      ]),
    ),
  };
  const bound = await bindPaymentReferenceProviders({
    bindings: new Map(
      references.map((boundReference) => [
        boundReference.index,
        {
          capability: "keyed" as const,
          identity: {
            kind: "tagged" as const,
            provider: boundReference.provider,
            reference: boundReference.reference,
          },
        },
      ]),
    ),
    ...claim,
  });
  if (bound.kind !== "bound") throw new Error("the provider was not bound");
  const booking = await queryOne<{ listing_id: number }>(
    `SELECT listingAttendee.listing_id
       FROM listing_attendees AS listingAttendee
      WHERE listingAttendee.attendee_id = ?`,
    [attendeeId],
  );
  if (booking === null) throw new Error("the attendee booking was not found");
  return {
    attendee: { id: attendeeId, name: "Buyer" },
    claim,
    listingId: booking.listing_id,
    paymentOnly: true,
    privateKey,
    reference,
    references,
    sessionId: first.sessionId,
  };
};

const confirmationCount = async (attendeeId: number): Promise<number> => {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM refund_confirmations AS confirmation
      WHERE confirmation.attendee_id = ?`,
    [attendeeId],
  );
  if (row === null) throw new Error("refund confirmation count was not found");
  return row.count;
};

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
        }),
      ),
    ).rejects.toThrow("A refund confirmation needs indexed payment references");

    expect(await confirmationCount(refund.attendee.id)).toBe(0);
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
  });

  test("writes activity and note cleanup once for one reference set", async () => {
    const refund = await setup();
    const target = attendeeNotes(refund.attendee.id);
    await createNamedSystemNote(
      target,
      `This booking could NOT be refunded automatically. Payment reference: ${refund.reference.reference}.`,
      { key: refund.reference.index, purpose: "refund_warning" },
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
        }),
      ),
      withTestSession(() =>
        confirmRefund({ ...refund, references: [first, second] }),
      ),
    ]);

    expect(results.sort()).toEqual(["current", "new"]);
    expect(await confirmationCount(refund.attendee.id)).toBe(1);
    expect(
      (await getAttendeeActivityLog(refund.attendee.id)).filter((entry) =>
        entry.message.includes("Payment marked as refunded"),
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
    const target = attendeeNotes(refund.attendee.id);
    await createNamedSystemNote(
      target,
      "This payment could NOT be refunded automatically.",
      { key: refund.reference.index, purpose: "refund_warning" },
    );
    await execute(
      `CREATE TRIGGER fail_refund_confirmation_activity
       BEFORE INSERT ON activity_log
       BEGIN
         SELECT RAISE(ABORT, 'activity write failed');
       END`,
    );

    await expect(
      withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).rejects.toThrow("activity write failed");

    expect(await confirmationCount(refund.attendee.id)).toBe(0);
    expect(await getAttendeeActivityLog(refund.attendee.id)).toEqual([]);
    expect(
      (await getNotesFor(target, refund.privateKey)).map((note) => note.note),
    ).toEqual(["This payment could NOT be refunded automatically."]);
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

  test("does not open unrelated history to decide whether this is a replay", async () => {
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
        confirmRefund({ ...refund, references: [refund.reference] }),
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
