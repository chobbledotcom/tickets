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
import {
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReferenceSet,
} from "#db/payment-references.ts";
import { sql } from "#db/sql.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
  resaveAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookLegacyPaidAttendee,
  seedHistoricalProcessedPayment,
} from "#test-utils/historical-payment-references.ts";
import { protectedStateOf } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import type { Attendee } from "#types";

type StoredPaymentRow = {
  payment_reference_index: string;
  payment_session_id: string;
};

const paymentRowsFor = (attendeeId: number): Promise<StoredPaymentRow[]> =>
  queryAll<StoredPaymentRow>(
    sql`SELECT payment_session_id, payment_reference_index
       FROM processed_payments
      WHERE attendee_id = ${attendeeId}
      ORDER BY payment_session_id`,
  );

/** Book one attendee, named by the case, on a listing of its own. */
const bookOnOwnListing = async (
  email: string,
  name: string,
  paymentId?: string,
): Promise<Attendee> =>
  bookedAttendee(
    await bookAttendee(await createTestListing(), {
      email,
      name,
      ...(paymentId === undefined ? {} : { paymentId }),
    }),
  );

/** The refund read for one attendee under the payment id the case reads. */
const refundSetFor = async (
  attendee: Attendee,
  currentPaymentId: string,
): Promise<RefundPaymentReferenceSet> =>
  await getRefundPaymentReferencesForAttendee(
    { currentPaymentId, id: attendee.id },
    await getTestPrivateKey(),
  );

describeWithEnv("db > payment reference readiness", { db: true }, () => {
  test("a refund read never selects attendees or repairs old payment rows", async () => {
    const selected = await bookOnOwnListing(
      "selected-legacy@example.com",
      "Selected Legacy",
      "selected_legacy_payment",
    );
    const unrelated = await bookOnOwnListing(
      "unrelated-legacy@example.com",
      "Unrelated Legacy",
      "unrelated_legacy_payment",
    );
    await seedHistoricalProcessedPayment(
      "unrelated_unindexed",
      unrelated.id,
      "unrelated_old_row",
    );
    await execute(
      sql`UPDATE processed_payments
          SET payment_reference = ${"not a payment reference"}, payment_reference_index = ${"unrelated-old-index"}
        WHERE payment_session_id = ${"unrelated_unindexed"}`,
    );

    const queries: string[] = [];
    const restore = recordQueries(queries);
    let references: RefundPaymentReferenceSet;
    try {
      references = await refundSetFor(selected, selected.payment_id);
    } finally {
      restore();
    }

    expect(references).toEqual({ kind: "legacy_unindexed" });
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
    const { attendee } = await bookLegacyPaidAttendee(
      "old_unindexed",
      "pi_unindexed_old",
    );
    await finalizeProcessedPayment("new_indexed", attendee.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_indexed_new",
    });

    expect(await refundSetFor(attendee, attendee.payment_id)).toEqual({
      kind: "legacy_unindexed",
    });
    expect(await protectedStateOf("old_unindexed")).toBe("");
    expect(await protectedStateOf("new_indexed")).toBe("");
  });

  test("an oversized history is refused before any reference is decrypted", async () => {
    const attendee = await bookOnOwnListing(
      "large-payment-history@example.com",
      "Large Payment History",
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
      sql`UPDATE processed_payments SET payment_reference = 'not ciphertext' WHERE attendee_id = ${attendee.id}`,
    );

    expect(await refundSetFor(attendee, "")).toEqual({
      kind: "too_many_references",
    });
    expect(await loadSelectedPaymentReferenceRows([attendee.id])).toHaveLength(
      MAX_REFUND_REFERENCES_PER_ATTENDEE + 1,
    );
  });

  test("re-saving a PII-only payment does not manufacture refund identity", async () => {
    const attendee = await bookOnOwnListing(
      "resaved-legacy@example.com",
      "Resaved Legacy",
      "resaved_legacy_payment",
    );

    await resaveAttendee(attendee);
    await resaveAttendee(attendee);

    expect(await paymentRowsFor(attendee.id)).toEqual([]);
    expect(await refundSetFor(attendee, attendee.payment_id)).toEqual({
      kind: "legacy_unindexed",
    });
  });

  test("an ordinary save never reads or opens unnamed note history", async () => {
    const attendee = await bookOnOwnListing(
      "atomic-warning@example.com",
      "Atomic Warning",
      "pi_atomic_warning",
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
      sql`SELECT system_name
         FROM system_notes AS note
        WHERE note.entity_type = 'attendee' AND note.entity_id = ${attendee.id}`,
    );
    expect(warning).toEqual([{ system_name: null }]);
  });

  test("an atomic attendee edit does not manufacture refund identity", async () => {
    const attendee = await bookOnOwnListing(
      "atomic-legacy@example.com",
      "Atomic Legacy",
      "atomic_legacy_payment",
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
      { allowOverbook: true },
    );

    expect(result.success).toBe(true);
    expect(await paymentRowsFor(attendee.id)).toEqual([]);
  });

  test("a changed PII-only payment remains unindexed", async () => {
    const attendee = await bookOnOwnListing(
      "changed-legacy@example.com",
      "Changed Legacy",
      "first_legacy_payment",
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
    expect(await refundSetFor(attendee, "second_legacy_payment")).toEqual({
      kind: "legacy_unindexed",
    });
  });

  test("re-saving a finalized payment does not add a redundant anchor", async () => {
    const attendee = await bookOnOwnListing(
      "canonical-payment@example.com",
      "Canonical Payment",
      "canonical_payment",
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
