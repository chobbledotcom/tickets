import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import { prepareClaimedAttendeePaymentAnchor } from "#shared/db/payment-anchor/attendee.ts";
import { settleAttendeeRows } from "#shared/db/payment-claim.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#shared/db/payment-reference-store.ts";
import { rowNodeOf } from "#shared/payment/row-machine-spec.ts";
import { readRowState } from "#shared/payment/row-state.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";

type StoredAnchor = {
  failure_data: EnvKeyEncrypted | "";
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
  protected_state: string;
};

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
    `SELECT failure_data, payment_reference, payment_reference_index,
            payment_session_id, protected_state
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
      const prepared = await prepareClaimedAttendeePaymentAnchor(payment);
      const anchor = await prepared.forAttendee(attendeeId);

      for (const _attempt of [1, 2]) {
        await execute(anchor.statement.sql, anchor.statement.args);
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
      const prepared = await prepareClaimedAttendeePaymentAnchor(payment);
      const anchor = await prepared.forAttendee(999_999);
      await execute(anchor.statement.sql, anchor.statement.args);

      expect(
        await queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM processed_payments WHERE payment_reference_index = ?",
          [await paymentReferenceIndex(payment)],
        ),
      ).toEqual({ count: 0 });
    });

    test("stores and retires the canonical claim with its mirror", async () => {
      const attendeeId = await makeAttendee();
      const prepared = await prepareClaimedAttendeePaymentAnchor(
        taggedPaymentReference("pi_claimed_anchor"),
      );
      const anchor = await prepared.forAttendee(attendeeId);
      await execute(anchor.statement.sql, anchor.statement.args);

      const [held] = await anchorRows(attendeeId);
      if (held === undefined || held.failure_data === "") {
        throw new Error("claimed anchor was not stored");
      }
      expect(held.protected_state).toBe("claim");
      expect(
        readRowState(await decrypt(held.failure_data), "claimed anchor test")
          .claim,
      ).toEqual({
        attendeeIds: [attendeeId],
        commandId: anchor.settlement.commandId,
        phase: "checking",
        scope: "attendee_set",
        writtenAt: anchor.settlement.heldSince,
      });

      await settleAttendeeRows(anchor.settlement);
      expect(await anchorRows(attendeeId)).toMatchObject([
        { failure_data: "", protected_state: "" },
      ]);
    });

    test("born with returned money, the row holds claim and unrecorded work", async () => {
      const attendeeId = await makeAttendee();
      const returnedAt = "2026-08-16T09:00:00.000Z";
      const prepared = await prepareClaimedAttendeePaymentAnchor(
        taggedPaymentReference("pi_born_unrecorded"),
        returnedAt,
      );
      const anchor = await prepared.forAttendee(attendeeId);
      await execute(anchor.statement.sql, anchor.statement.args);

      const [held] = await anchorRows(attendeeId);
      if (held === undefined || held.failure_data === "") {
        throw new Error("claimed anchor was not stored");
      }
      const state = readRowState(
        await decrypt(held.failure_data),
        "born unrecorded test",
      );
      expect(rowNodeOf(state)).toBe("claim_unrecorded");
      expect(state.unrecorded).toEqual({ returnedAt });
      // The claim outranks the money marker in the one-word mirror.
      expect(held.protected_state).toBe("claim");

      // Settling with the books recorded clears both pieces of work.
      await settleAttendeeRows({
        commandId: anchor.settlement.commandId,
        heldSince: anchor.settlement.heldSince,
        rows: new Map([
          [
            anchor.sessionId,
            { books: "recorded", claim: "release", phase: "checking" },
          ],
        ]),
      });
      expect(await anchorRows(attendeeId)).toMatchObject([
        { failure_data: "", protected_state: "" },
      ]);
    });

    test("cannot pair one anchor with another attendee's settlement", async () => {
      const attendeeId = await makeAttendee();
      const prepared = await prepareClaimedAttendeePaymentAnchor(
        taggedPaymentReference("pi_bound_anchor"),
      );
      await prepared.forAttendee(attendeeId);

      expect(() => prepared.forAttendee(attendeeId + 1)).toThrow(
        `Payment anchor was already bound to attendee ${attendeeId}`,
      );
    });
  });
});
