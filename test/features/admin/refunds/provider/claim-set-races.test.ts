import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { updateAttendeePII } from "#shared/db/attendees/update.ts";
import { execute, requireOne } from "#shared/db/client.ts";
import { claimAttendeeRows } from "#shared/db/payment-claim/take.ts";
import { getRefundPaymentReferencesForAttendee } from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { releaseClaimRows } from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

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
  references: await getRefundPaymentReferencesForAttendee(
    attendee,
    await getTestPrivateKey(),
  ),
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

    test("does not refund a row-less charge after its attendee disappears", async () => {
      const listing = await createTestListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Gone Buyer",
        "gone-before-claim@example.com",
        "pi_gone_before_claim",
      );
      const candidate = await withStoredRevision(attendee);
      await execute("DELETE FROM attendees WHERE id = ?", [attendee.id]);

      await expectRunStandsDown(candidate, listing.id);
    });

    test("does not refund a legacy anchor deleted after it was loaded", async () => {
      const listing = await createTestListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Anchored Buyer",
        "anchor-gone@example.com",
        "pi_anchor_gone",
      );
      const first = await withStoredRevision(attendee);
      const claim = await claimAttendeeRows(
        [
          {
            attendeeId: attendee.id,
            loadedPiiBlob: first.attendee.pii_blob,
            references: first.references,
          },
        ],
        "keyless",
      );
      if (claim.kind !== "claimed") throw new Error("the anchor was not held");
      await releaseClaimRows(claim, [...claim.held.values()].flat());
      const candidate = await withStoredRevision(attendee);
      const [anchor] = candidate.references.flatMap(
        (reference) => reference.rowSessionIds,
      );
      if (anchor === undefined) throw new Error("the anchor was not loaded");
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        [anchor],
      );

      await expectRunStandsDown(candidate, listing.id);
    });

    test("does not refund after the attendee PII revision changes", async () => {
      const listing = await createTestListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Original Buyer",
        "edited-before-claim@example.com",
        "pi_edited_before_claim",
      );
      const candidate = await withStoredRevision(attendee);
      await updateAttendeePII(attendee.id, {
        address: attendee.address,
        email: attendee.email,
        lat: attendee.lat,
        lng: attendee.lng,
        name: "Edited Buyer",
        payment_id: attendee.payment_id,
        phone: attendee.phone,
        special_instructions: attendee.special_instructions,
        ticket_token: attendee.ticket_token,
      });

      await expectRunStandsDown(candidate, listing.id);
    });
  },
);
