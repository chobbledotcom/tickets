import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import {
  attendeePaymentAnchorStatements,
  prepareAttendeePaymentAnchor,
} from "#shared/db/payment-anchor/attendee.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#shared/db/payment-reference-store.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

type StoredAnchor = {
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
};

const untagged = (reference: string): PaymentReference => ({
  kind: "untagged",
  reference,
});

const makeAttendee = async (): Promise<number> => {
  const listing = await createTestListing({ maxAttendees: 20 });
  const made = await bookAttendee(listing, {
    email: "anchor@example.com",
    name: "Payment Anchor",
  });
  if (!made.success) throw new Error("attendee setup failed");
  return made.attendees[0]!.id;
};

const anchorRows = (attendeeId: number): Promise<StoredAnchor[]> =>
  queryAll<StoredAnchor>(
    `SELECT payment_reference, payment_reference_index, payment_session_id
       FROM processed_payments
      WHERE attendee_id = ?
        AND payment_session_id LIKE 'legacy:%'
      ORDER BY payment_session_id`,
    [attendeeId],
  );

describeWithEnv("db > payment anchor > attendee", { db: true }, () => {
  describe("a prepared tagged anchor", () => {
    test("stores one encrypted, indexed identity and stays idempotent", async () => {
      const attendeeId = await makeAttendee();
      const payment = taggedPaymentReference("pi_attendee_anchor", "sumup");
      const statementFor = await prepareAttendeePaymentAnchor(payment);

      for (const _attempt of [1, 2]) {
        const statement = statementFor(attendeeId);
        await execute(statement.sql, statement.args);
      }

      const rows = await anchorRows(attendeeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payment_reference).not.toContain(payment.reference);
      expect(rows[0]!.payment_reference_index).toBe(
        await paymentReferenceIndex(payment),
      );
      expect(rows[0]!.payment_session_id).toBe(
        `legacy:${attendeeId}:${rows[0]!.payment_reference_index}`,
      );
      expect(
        await loadPaymentReference(
          rows[0]!.payment_reference,
          await getTestPrivateKey(),
          "attendee payment anchor test",
        ),
      ).toEqual(payment);
    });

    test("cannot create an ownerless payment row", async () => {
      const payment = taggedPaymentReference("pi_missing_attendee");
      const statement = (await prepareAttendeePaymentAnchor(payment))(999_999);
      await execute(statement.sql, statement.args);

      expect(
        await queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM processed_payments WHERE payment_reference_index = ?",
          [await paymentReferenceIndex(payment)],
        ),
      ).toEqual({ count: 0 });
    });
  });

  describe("an old PII payment id", () => {
    test("a blank id produces no statement", async () => {
      expect(await attendeePaymentAnchorStatements(1, "")).toEqual([]);
    });

    test("is stored as untagged", async () => {
      const attendeeId = await makeAttendee();
      const payment = untagged("pi_old_attendee");
      const [statement] = await attendeePaymentAnchorStatements(
        attendeeId,
        payment.reference,
      );
      if (statement === undefined) throw new Error("anchor was not prepared");
      await execute(statement.sql, statement.args);

      const [row] = await anchorRows(attendeeId);
      if (row === undefined) throw new Error("anchor was not stored");
      expect(
        await loadPaymentReference(
          row.payment_reference,
          await getTestPrivateKey(),
          "legacy attendee anchor test",
        ),
      ).toEqual(payment);
    });

    test("does not duplicate a checkout row with the tagged spelling", async () => {
      const attendeeId = await makeAttendee();
      const reference = "pi_already_finalized";
      await finalizeProcessedPayment(
        "sess_already_finalized",
        attendeeId,
        "",
        taggedPaymentReference(reference, "stripe"),
      );
      const [statement] = await attendeePaymentAnchorStatements(
        attendeeId,
        reference,
      );
      if (statement === undefined) throw new Error("anchor was not prepared");
      await execute(statement.sql, statement.args);

      expect(await anchorRows(attendeeId)).toEqual([]);
    });
  });
});
