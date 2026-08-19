import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { updateAttendeePII } from "#db/attendees/update.ts";
import { execute, requireOne } from "#db/client.ts";
import { getRefundPaymentReferencesForAttendee } from "#db/payment-references.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { requireCompleteRefundReferences } from "#test-utils/payment-references.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import type { Attendee } from "#types";

const withStoredRevision = async (
  attendee: Pick<Attendee, "id" | "payment_id">,
): Promise<RefundCandidate> => ({
  attendee: {
    ...attendee,
    pii_blob: (
      await requireOne<{ pii_blob: Attendee["pii_blob"] }>(
        "SELECT pii_blob FROM attendees WHERE id = ?",
        [attendee.id],
      )
    ).pii_blob,
  } as Attendee,
  references: requireCompleteRefundReferences(
    await getRefundPaymentReferencesForAttendee(
      { currentPaymentId: attendee.payment_id, id: attendee.id },
      await getTestPrivateKey(),
    ),
  ),
});

const resave = (attendee: Attendee, name = attendee.name): Promise<void> =>
  updateAttendeePII(attendee.id, {
    address: attendee.address,
    email: attendee.email,
    lat: attendee.lat,
    lng: attendee.lng,
    name,
    payment_id: attendee.payment_id,
    phone: attendee.phone,
    special_instructions: attendee.special_instructions,
    ticket_token: attendee.ticket_token,
  });

const expectRunStandsDown = async (
  candidate: RefundCandidate,
  listingId: number,
): Promise<void> => {
  let prepared = false;
  const result = await processRefundBatch([candidate], listingId, {
    prepare: () => {
      prepared = true;
      throw new Error("readiness must not start for a changed row set");
    },
  });
  expect(result).toMatchObject({
    counts: { failedCount: 1 },
    kind: "not_ready",
    message:
      "The attendee or payment set changed while this refund was starting. Try again.",
  });
  expect(prepared).toBe(false);
};

describeWithEnv(
  "admin refund provider > the loaded payment set",
  { db: true, encryptionKey: true },
  () => {
    setupErrorSpy();

    test("does not refund a payment row deleted after it was loaded", async () => {
      const attendeeId = await bookedWithPayment(
        "sess_deleted_before_claim",
        "pi_deleted_before_claim",
      );
      const candidate = await withStoredRevision({
        id: attendeeId,
        payment_id: "",
      });
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        ["sess_deleted_before_claim"],
      );
      await expectRunStandsDown(candidate, 7);
    });

    test("does not refund a payment row moved after it was loaded", async () => {
      const attendeeId = await bookedWithPayment(
        "sess_moved_before_claim",
        "pi_moved_before_claim",
      );
      const candidate = await withStoredRevision({
        id: attendeeId,
        payment_id: "",
      });
      const destinationId = await bookedWithPayment(
        "sess_move_destination",
        "pi_move_destination",
      );
      await execute(
        "UPDATE processed_payments SET attendee_id = ? WHERE payment_session_id = ?",
        [destinationId, "sess_moved_before_claim"],
      );

      await expectRunStandsDown(candidate, 7);
    });

    test("does not refund when a payment row is added after loading", async () => {
      const attendeeId = await bookedWithPayment(
        "sess_original_before_claim",
        "pi_original_before_claim",
      );
      const candidate = await withStoredRevision({
        id: attendeeId,
        payment_id: "",
      });
      await finalizeProcessedPayment(
        "sess_added_before_claim",
        attendeeId,
        "tok-added",
        taggedPaymentReference("pi_added_before_claim"),
      );

      await expectRunStandsDown(candidate, 7);
    });

    test("does not refund when unindexed history appears after loading", async () => {
      const attendeeId = await bookedWithPayment(
        "sess_indexed_before_history",
        "pi_indexed_before_history",
      );
      const candidate = await withStoredRevision({
        id: attendeeId,
        payment_id: "",
      });
      await finalizeProcessedPayment(
        "sess_unindexed_after_load",
        attendeeId,
        "tok-unindexed",
        taggedPaymentReference("pi_unindexed_after_load"),
      );
      await execute(
        `UPDATE processed_payments
            SET payment_reference_index = ''
          WHERE payment_session_id = ?`,
        ["sess_unindexed_after_load"],
      );

      await expectRunStandsDown(candidate, 7);
    });

    test("does not refund after the attendee PII revision changes", async () => {
      const attendeeId = await bookedWithPayment(
        "sess_edited_before_claim",
        "pi_edited_before_claim",
      );
      const attendee = await getAttendeeOrNull(
        attendeeId,
        await getTestPrivateKey(),
      );
      if (attendee === null) throw new Error("the attendee was not loaded");
      const candidate = await withStoredRevision(attendee);
      await resave(attendee, "Edited Buyer");

      await expectRunStandsDown(candidate, 7);
    });
  },
);
