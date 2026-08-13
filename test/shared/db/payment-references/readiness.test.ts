import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import {
  applyAttendeeAtomicEdit,
  loadExistingLines,
} from "#shared/db/attendees/atomic-update.ts";
import { updateAttendeePII } from "#shared/db/attendees/update.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { createSystemNote } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
  resaveAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  claimCurrentAttendeeRows,
  heldSessionIds,
  protectedStateOf,
} from "#test-utils/payment-claim.ts";
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
    await finalizeProcessedPayment("unrelated_unindexed", unrelated.id, "", {
      kind: "untagged",
      reference: "unrelated_old_row",
    });
    await execute(
      `UPDATE processed_payments
          SET payment_reference = ?, payment_reference_index = ?
        WHERE payment_session_id = ?`,
      ["not a payment reference", "unrelated-old-index", "unrelated_unindexed"],
    );

    const queries: string[] = [];
    const restore = recordQueries(queries);
    let references: Map<number, unknown[]>;
    try {
      references = await getRefundPaymentReferences(
        [{ id: selected.id, payment_id: selected.payment_id }],
        await getTestPrivateKey(),
      );
    } finally {
      restore();
    }

    expect(references.get(selected.id)).toEqual([]);
    expect(queries.some((sql) => sql.includes("FROM attendees"))).toBe(false);
    expect(await paymentRowsFor(selected.id)).toEqual([]);
    expect(await paymentRowsFor(unrelated.id)).toEqual([
      {
        payment_reference_index: "unrelated-old-index",
        payment_session_id: "unrelated_unindexed",
      },
    ]);
  });

  test("an unindexed old row cannot block a newer indexed payment", async () => {
    const listing = await createTestListing();
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "mixed-readiness@example.com",
        name: "Mixed Readiness",
        paymentId: "pi_pii_only_old",
      }),
    );
    await finalizeProcessedPayment("old_unindexed", attendee.id, "", {
      kind: "untagged",
      reference: "pi_unindexed_old",
    });
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

    const claimed = await claimCurrentAttendeeRows([attendee.id]);

    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("indexed row was refused");
    expect(heldSessionIds(claimed)).toEqual(["new_indexed"]);
    expect(await protectedStateOf("old_unindexed")).toBe("");
  });

  test("re-saving one old attendee creates one append-only indexed anchor", async () => {
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

    const rows = await paymentRowsFor(attendee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payment_reference_index).not.toBe("");
    expect(
      (
        await getRefundPaymentReferences(
          [{ id: attendee.id, payment_id: attendee.payment_id }],
          await getTestPrivateKey(),
        )
      )
        .get(attendee.id)
        ?.map((reference) => reference.reference),
    ).toEqual(["resaved_legacy_payment"]);
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
    expect(await paymentRowsFor(attendee.id)).toHaveLength(1);
    const warning = await queryAll<{ system_name: string | null }>(
      `SELECT system_name
         FROM system_notes AS note
        WHERE note.entity_type = 'attendee' AND note.entity_id = ?`,
      [attendee.id],
    );
    expect(warning).toEqual([{ system_name: null }]);
  });

  test("an atomic attendee edit materializes its existing legacy payment", async () => {
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
    expect(await paymentRowsFor(attendee.id)).toHaveLength(1);
  });

  test("a changed legacy payment keeps the earlier indexed identity", async () => {
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

    expect(await paymentRowsFor(attendee.id)).toHaveLength(2);
    expect(
      (
        await getRefundPaymentReferences(
          [{ id: attendee.id, payment_id: "second_legacy_payment" }],
          await getTestPrivateKey(),
        )
      )
        .get(attendee.id)
        ?.map((reference) => reference.reference)
        .sort(),
    ).toEqual(["first_legacy_payment", "second_legacy_payment"]);
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
