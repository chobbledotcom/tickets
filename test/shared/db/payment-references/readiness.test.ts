import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import {
  applyAttendeeAtomicEdit,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { updateAttendeePII } from "#db/attendees/update.ts";
import { execute, queryAll } from "#db/client.ts";
import { createSystemNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import {
  loadSelectedPaymentReferenceRows,
  MAX_REFUND_REFERENCES_PER_ATTENDEE,
} from "#db/payment-reference-rows.ts";
import { getRefundPaymentReferences } from "#db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
  resaveAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedHistoricalProcessedPayment } from "#test-utils/historical-payment-references.ts";
import { protectedStateOf } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

type StoredPaymentRow = {
  payment_reference_index: string;
  payment_session_id: string;
};

const paymentRowsFor = (attendeeId: number): Promise<StoredPaymentRow[]> =>
  queryAll<StoredPaymentRow>(
    `SELECT payment_session_id, payment_reference_index
       FROM processed_payments
      WHERE attendee_id = ?
      ORDER BY payment_session_id`,
    [attendeeId],
  );

describeWithEnv("db > payment reference readiness", { db: true }, () => {
  test("a refund read never selects attendees or repairs old payment rows", async () => {
    const listing = await createTestListing();
    const selected = bookedAttendee(
      await bookAttendee(listing, {
        email: "selected-legacy@example.com",
        name: "Selected Legacy",
        paymentId: "selected_legacy_payment",
      }),
    );
    const unrelated = bookedAttendee(
      await bookAttendee(listing, {
        email: "unrelated-legacy@example.com",
        name: "Unrelated Legacy",
        paymentId: "unrelated_legacy_payment",
      }),
    );
    await seedHistoricalProcessedPayment(
      "unrelated_unindexed",
      unrelated.id,
      "unrelated_old_row",
    );
    await execute(
      `UPDATE processed_payments
          SET payment_reference = ?, payment_reference_index = ?
        WHERE payment_session_id = ?`,
      ["not a payment reference", "unrelated-old-index", "unrelated_unindexed"],
    );

    const queries: string[] = [];
    const restore = recordQueries(queries);
    let references: Awaited<ReturnType<typeof getRefundPaymentReferences>>;
    try {
      references = await getRefundPaymentReferences(
        [{ currentPaymentId: selected.payment_id, id: selected.id }],
        await getTestPrivateKey(),
      );
    } finally {
      restore();
    }

    expect(references.get(selected.id)).toEqual({ kind: "legacy_unindexed" });
    expect(queries.some((sql) => sql.includes("FROM attendees"))).toBe(false);
    expect(await paymentRowsFor(selected.id)).toEqual([]);
    expect(await paymentRowsFor(unrelated.id)).toEqual([
      {
        payment_reference_index: "unrelated-old-index",
        payment_session_id: "unrelated_unindexed",
      },
    ]);
  });

  test("an unindexed old row refuses the newer indexed subset", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "mixed-readiness@example.com",
        name: "Mixed Readiness",
        paymentId: "pi_pii_only_old",
      }),
    );
    await seedHistoricalProcessedPayment(
      "old_unindexed",
      attendee.id,
      "pi_unindexed_old",
    );
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ''
        WHERE payment_session_id = ?`,
      ["old_unindexed"],
    );
    await finalizeProcessedPayment("new_indexed", attendee.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_indexed_new",
    });

    const references = await getRefundPaymentReferences(
      [{ currentPaymentId: attendee.payment_id, id: attendee.id }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendee.id)).toEqual({
      kind: "legacy_unindexed",
    });
    expect(await protectedStateOf("old_unindexed")).toBe("");
    expect(await protectedStateOf("new_indexed")).toBe("");
  });

  test("an oversized history is refused before any reference is decrypted", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "large-payment-history@example.com",
        name: "Large Payment History",
      }),
    );
    await Promise.all(
      Array.from(
        { length: MAX_REFUND_REFERENCES_PER_ATTENDEE + 5 },
        (_, index) =>
          finalizeProcessedPayment(`large-history-${index}`, attendee.id, "", {
            kind: "tagged",
            provider: "stripe",
            reference: `pi_large_history_${index}`,
          }),
      ),
    );
    await execute(
      "UPDATE processed_payments SET payment_reference = 'not ciphertext' WHERE attendee_id = ?",
      [attendee.id],
    );

    expect(
      (
        await getRefundPaymentReferences(
          [{ currentPaymentId: "", id: attendee.id }],
          await getTestPrivateKey(),
        )
      ).get(attendee.id),
    ).toEqual({ kind: "too_many_references" });
    expect(await loadSelectedPaymentReferenceRows([attendee.id])).toHaveLength(
      MAX_REFUND_REFERENCES_PER_ATTENDEE + 1,
    );
  });

  test("re-saving a PII-only payment does not manufacture refund identity", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "resaved-legacy@example.com",
        name: "Resaved Legacy",
        paymentId: "resaved_legacy_payment",
      }),
    );

    await resaveAttendee(attendee);
    await resaveAttendee(attendee);

    expect(await paymentRowsFor(attendee.id)).toEqual([]);
    expect(
      (
        await getRefundPaymentReferences(
          [{ currentPaymentId: attendee.payment_id, id: attendee.id }],
          await getTestPrivateKey(),
        )
      ).get(attendee.id),
    ).toEqual({ kind: "legacy_unindexed" });
  });

  test("an ordinary save never reads or opens unnamed note history", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "atomic-warning@example.com",
        name: "Atomic Warning",
        paymentId: "pi_atomic_warning",
      }),
    );
    await createSystemNote(
      attendeeNotes(attendee.id),
      "Historical unnamed payment warning",
    );
    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      await resaveAttendee(attendee);
    } finally {
      restore();
    }

    expect(queries.some((sql) => sql.includes("system_notes"))).toBe(false);
    expect(await paymentRowsFor(attendee.id)).toEqual([]);
    const warning = await queryAll<{ system_name: string | null }>(
      `SELECT system_name
         FROM system_notes AS note
        WHERE note.entity_type = 'attendee' AND note.entity_id = ?`,
      [attendee.id],
    );
    expect(warning).toEqual([{ system_name: null }]);
  });

  test("an atomic attendee edit does not manufacture refund identity", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "atomic-legacy@example.com",
        name: "Atomic Legacy",
        paymentId: "atomic_legacy_payment",
      }),
    );
    const [existing] = await loadExistingLines(attendee.id);
    if (existing === undefined) throw new Error("booking was not stored");
    const pii = {
      address: attendee.address,
      email: attendee.email,
      lat: attendee.lat,
      lng: attendee.lng,
      name: "Atomic Legacy Saved",
      payment_id: attendee.payment_id,
      phone: attendee.phone,
      special_instructions: attendee.special_instructions,
      ticket_token: attendee.ticket_token,
    };

    const result = await applyAttendeeAtomicEdit(
      attendee.id,
      pii,
      [
        {
          date: existing.booking.start_at?.slice(0, 10) ?? null,
          durationDays: 1,
          exists: true,
          key: existing.key,
          listingId: existing.booking.listing_id,
          quantity: existing.booking.quantity,
        },
      ],
      true,
    );

    expect(result.success).toBe(true);
    expect(await paymentRowsFor(attendee.id)).toEqual([]);
  });

  test("a changed PII-only payment remains unindexed", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "changed-legacy@example.com",
        name: "Changed Legacy",
        paymentId: "first_legacy_payment",
      }),
    );
    await resaveAttendee(attendee);

    await updateAttendeePII(attendee.id, {
      address: attendee.address,
      email: attendee.email,
      lat: attendee.lat,
      lng: attendee.lng,
      name: attendee.name,
      payment_id: "second_legacy_payment",
      phone: attendee.phone,
      special_instructions: attendee.special_instructions,
      ticket_token: attendee.ticket_token,
    });

    expect(await paymentRowsFor(attendee.id)).toEqual([]);
    expect(
      (
        await getRefundPaymentReferences(
          [{ currentPaymentId: "second_legacy_payment", id: attendee.id }],
          await getTestPrivateKey(),
        )
      ).get(attendee.id),
    ).toEqual({ kind: "legacy_unindexed" });
  });

  test("re-saving a finalized payment does not add a redundant anchor", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "canonical-payment@example.com",
        name: "Canonical Payment",
        paymentId: "canonical_payment",
      }),
    );
    await finalizeProcessedPayment("canonical_session", attendee.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: attendee.payment_id,
    });

    await resaveAttendee(attendee);

    expect(await paymentRowsFor(attendee.id)).toEqual([
      {
        payment_reference_index: (await paymentRowsFor(attendee.id))[0]!
          .payment_reference_index,
        payment_session_id: "canonical_session",
      },
    ]);
  });
});
