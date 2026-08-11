import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#shared/db/client.ts";
import {
  type AnchoredAttendee,
  anchorLegacyCharges,
} from "#shared/db/payment-anchor/mint.ts";
import { claimAttendeeRows } from "#shared/db/payment-claim.ts";
import {
  getRefundPaymentReferencesForAttendee,
  paymentReferenceIndex,
} from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { heldSessionIds } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const paymentRowCount = async (attendeeId: number): Promise<number> =>
  (
    await queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM processed_payments WHERE attendee_id = ?",
      [attendeeId],
    )
  )[0]!.n;

describeWithEnv(
  "db > anchoring a legacy charge",
  { db: true, encryptionKey: true },
  () => {
    const newAttendee = async (email: string): Promise<number> => {
      const listing = await createTestListing();
      const booked = await bookAttendee(listing, { email, name: "Buyer" });
      if (!booked.success) throw new Error("Failed to create the attendee");
      return booked.attendees[0]!.id;
    };

    /** What a run is about to act on for one attendee, read the way the refund
     *  routes read it. `paymentId` is the old column an ancient booking still
     *  carries its charge in. */
    const about = async (
      attendeeId: number,
      paymentId: string,
    ): Promise<AnchoredAttendee> => ({
      attendeeId,
      references: await getRefundPaymentReferencesForAttendee(
        { id: attendeeId, payment_id: paymentId },
        await getTestPrivateKey(),
      ),
    });

    test("a charge whose attendee has since gone gets no row at all", async () => {
      const attendeeId = await newAttendee("vanished@example.com");
      const held = await about(attendeeId, "pi_gone");

      // A run reads its candidates before it anchors, and a delete can land in
      // between: the delete refuses on payment rows, and this charge has none
      // for it to see. The row this would have minted names nobody, and the
      // claim on it would have let the run send money with no booking left to
      // record it against.
      await execute("DELETE FROM attendees AS attendee WHERE attendee.id = ?", [
        attendeeId,
      ]);
      await anchorLegacyCharges([held]);

      expect(await paymentRowCount(attendeeId)).toBe(0);
    });

    test("a charge with no row of its own cannot be held until it has one", async () => {
      const attendeeId = await newAttendee("legacy@example.com");

      // Nothing to claim, so the run is told it holds this attendee while
      // holding none of their money.
      expect(await claimAttendeeRows([attendeeId], "keyless")).toEqual({
        held: new Map(),
        heldSince: expect.any(String),
        kind: "claimed",
        returned: new Set(),
      });

      await anchorLegacyCharges([await about(attendeeId, "pi_old")]);

      const claim = await claimAttendeeRows([attendeeId], "keyless");
      if (claim.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(claim)).toEqual([
        `legacy:${attendeeId}:${await paymentReferenceIndex("pi_old")}`,
      ]);
    });

    test("a second run is turned away from an anchored legacy charge", async () => {
      const attendeeId = await newAttendee("legacy2@example.com");
      await anchorLegacyCharges([await about(attendeeId, "pi_once")]);

      expect(await claimAttendeeRows([attendeeId], "keyless")).toMatchObject({
        kind: "claimed",
      });
      // The whole point: with no row to hold, both runs passed this line and
      // both sent a payout against the one charge.
      expect(await claimAttendeeRows([attendeeId], "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("two runs anchoring the same charge leave one row", async () => {
      const attendeeId = await newAttendee("legacy3@example.com");
      const run = [await about(attendeeId, "pi_twice")];

      await anchorLegacyCharges(run);
      await anchorLegacyCharges(run);

      // The row names the attendee and the charge, so the second write has
      // nothing to add.
      expect(await paymentRowCount(attendeeId)).toBe(1);
    });

    test("a charge already on a row is left alone", async () => {
      const attendeeId = await newAttendee("recorded@example.com");
      await finalizeProcessedPayment("sess-recorded", attendeeId, "", "pi_new");

      const run = [await about(attendeeId, "")];
      const calls = await countDatabaseCalls(0, () => anchorLegacyCharges(run));

      // The normal case: nothing is missing, so nothing is written.
      expect(calls).toBe(0);
      expect(await paymentRowCount(attendeeId)).toBe(1);
    });

    test("anchoring nobody reaches no database", async () => {
      expect(await countDatabaseCalls(0, () => anchorLegacyCharges([]))).toBe(
        0,
      );
    });
  },
);
