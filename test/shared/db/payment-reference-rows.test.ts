import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { loadSelectedPaymentReferenceRows } from "#shared/db/payment-reference-rows.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

describeWithEnv("db > selected payment reference rows", { db: true }, () => {
  test("returns no rows for no selected attendees", async () => {
    expect(await loadSelectedPaymentReferenceRows([])).toEqual([]);
  });

  test("reports old history without returning its reference or another attendee", async () => {
    const listing = await createTestListing();
    const selected = bookedAttendee(
      await bookAttendee(listing, {
        email: "selected-reference@example.com",
        name: "Selected Reference",
      }),
    );
    const unrelated = bookedAttendee(
      await bookAttendee(listing, {
        email: "unrelated-reference@example.com",
        name: "Unrelated Reference",
      }),
    );
    await finalizeProcessedPayment(
      "selected_indexed",
      selected.id,
      "",
      taggedPaymentReference("pi_selected_indexed"),
    );
    await execute(
      `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        "selected_unindexed",
        selected.id,
        "2026-08-13T00:00:00.000Z",
        "pi_selected_unindexed",
        "unrelated_unindexed",
        unrelated.id,
        "2026-08-13T00:00:00.000Z",
        "pi_unrelated_unindexed",
      ],
    );

    const rows = await loadSelectedPaymentReferenceRows([selected.id]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => Number(row.attendee_id) === selected.id)).toBe(
      true,
    );
    expect(rows.find((row) => Number(row.unindexed_history) === 1)).toEqual({
      attendee_id: selected.id,
      payment_reference: "",
      payment_reference_index: "",
      payment_session_id: "",
      protected_state: "",
      reference_number: 0,
      refund_state_name: null,
      unindexed_history: 1,
    });
    expect(
      rows.some((row) => row.payment_reference.includes("unindexed")),
    ).toBe(false);
  });
});
