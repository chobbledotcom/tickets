/** The resume's one read: every anchor row for a payment, and nothing else. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { prepareClaimedAttendeePaymentAnchor } from "#shared/db/payment-anchor/attendee.ts";
import { loadAnchorRowWork } from "#shared/db/payment-anchor/held-work.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";

describeWithEnv("db > payment anchor > held work", { db: true }, () => {
  test("reads only the payment's anchor rows, never the session's own", async () => {
    const listing = await createTestListing({ maxAttendees: 20 });
    const made = await bookAttendee(listing, {
      email: "held@example.com",
      name: "Held Work",
    });
    if (!made.success) throw new Error("attendee setup failed");
    const attendeeId = made.attendees[0]!.id;
    const payment = taggedPaymentReference("pi_held_work");
    const prepared = await prepareClaimedAttendeePaymentAnchor(payment);
    const anchor = await prepared.forAttendee(attendeeId);
    await execute(anchor.statement.sql, anchor.statement.args);
    // The session's own idempotency row can carry the same reference index
    // once finalized; the anchor read must still not return it.
    await reserveSession("cs_held_work");
    await execute(
      "UPDATE processed_payments SET payment_reference_index = ? WHERE payment_session_id = 'cs_held_work'",
      [await paymentReferenceIndex(payment)],
    );

    const rows = await loadAnchorRowWork(payment);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.record.sessionId).toBe(anchor.sessionId);
    expect(rows[0]!.record.attendeeId).toBe(attendeeId);
    expect(rows[0]!.record.state.claim?.commandId).toBe(
      anchor.settlement.commandId,
    );
    // No charge row exists for this payment, so the joined state is empty.
    expect(rows[0]!.refundStateName).toBeNull();
  });

  test("answers empty for a payment nothing anchors", async () => {
    expect(
      await loadAnchorRowWork(taggedPaymentReference("pi_nothing_anchored")),
    ).toEqual([]);
  });
});
