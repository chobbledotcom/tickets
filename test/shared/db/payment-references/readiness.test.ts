import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  paymentReferenceIndex,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

const storedIndex = (sessionId: string): Promise<{ value: string } | null> =>
  queryOne<{ value: string }>(
    `SELECT payment_reference_index AS value
       FROM processed_payments
      WHERE payment_session_id = ?`,
    [sessionId],
  );

describeWithEnv("db > payment reference readiness", { db: true }, () => {
  test("an authenticated read indexes every old row sharing its reference", async () => {
    const listing = await createTestListing();
    const first = bookedAttendee(
      await bookAttendee(listing, {
        email: "reference-ready-a@example.com",
        name: "Reference Ready A",
      }),
    );
    const second = bookedAttendee(
      await bookAttendee(listing, {
        email: "reference-ready-b@example.com",
        name: "Reference Ready B",
      }),
    );
    const payment = {
      kind: "untagged",
      reference: "shared_before_indexes",
    } as const;
    await finalizeProcessedPayment("ready_first", first.id, "", payment);
    await finalizeProcessedPayment("ready_second", second.id, "", payment);
    const oldStored = await storePaymentReference(payment);
    await execute(
      `UPDATE processed_payments
          SET payment_reference = ?, payment_reference_index = ''
        WHERE payment_session_id IN (?, ?)`,
      [oldStored.encrypted, "ready_first", "ready_second"],
    );

    await getRefundPaymentReferences(
      [{ id: first.id, payment_id: "" }],
      await getTestPrivateKey(),
    );

    const expected = await paymentReferenceIndex(payment);
    expect(await storedIndex("ready_first")).toEqual({ value: expected });
    expect(await storedIndex("ready_second")).toEqual({ value: expected });
  });
});
