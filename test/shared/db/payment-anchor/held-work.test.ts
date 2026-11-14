/** The resume's one read: every anchor row for a payment, and nothing else. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { loadAnchorRowWork } from "#db/payment-anchor/held-work.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAnchoredAttendee } from "#test-utils/db-helpers/attendee-anchor.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";

describeWithEnv("db > payment anchor > held work", { db: true }, () => {
  test("reads only the payment's anchor rows, never the session's own", async () => {
    const { anchor, attendeeId, payment } = await bookAnchoredAttendee(
      "pi_held_work",
      { email: "held@example.com", name: "Held Work" },
    );
    // The session's own idempotency row can carry the same reference index
    // once finalized; the anchor read must still not return it.
    await reserveSession("cs_held_work");
    await execute(
      sql`UPDATE processed_payments SET payment_reference_index = ${await paymentReferenceIndex(payment)} WHERE payment_session_id = 'cs_held_work'`,
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
