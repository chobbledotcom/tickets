import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { queryOne } from "#shared/db/client.ts";
import { CLAIM_MIRROR } from "#shared/db/payment-claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  freshClaimSlot,
  putRowState,
  rowStateSlot,
  staleClaimSlot,
} from "#test-utils/payment-claim.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";

const CLAIM_REFUSAL =
  "A refund for this person is still in progress. Finish or re-run the refund, then try again.";
const REVIEW_REFUSAL =
  "The owner still has to check a payment for this person. Mark it reviewed, then try again.";

/** What a refused delete says, or null when it went through. */
const deleteRefusal = (attendeeId: number): Promise<string | null> =>
  deleteAttendee(attendeeId).then(
    () => null,
    (error: Error) => error.message,
  );

const attendeeStillThere = async (attendeeId: number): Promise<boolean> =>
  (await queryOne<{ id: number }>("SELECT id FROM attendees WHERE id = ?", [
    attendeeId,
  ])) !== null;

const paymentStillThere = async (sessionId: string): Promise<boolean> =>
  (await queryOne<{ id: number }>(
    "SELECT rowid AS id FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  )) !== null;

describeWithEnv(
  "db > deleting an attendee whose payment is busy",
  { db: true, encryptionKey: true },
  () => {
    test("a delete is refused while a refund run holds the payment", async () => {
      const attendeeId = await bookedWithPayment("sess-busy-1", "pi_busy_1");
      await putRowState(
        "sess-busy-1",
        await freshClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );
      expect(await deleteRefusal(attendeeId)).toBe(CLAIM_REFUSAL);
    });

    test("the refused delete leaves the attendee and the payment where they were", async () => {
      const attendeeId = await bookedWithPayment("sess-busy-2", "pi_busy_2");
      await putRowState(
        "sess-busy-2",
        await freshClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );
      await deleteRefusal(attendeeId);
      // Failing closed is only worth anything if the whole cascade rolls back:
      // the payment row is the record that money may already be going back.
      expect(await attendeeStillThere(attendeeId)).toBe(true);
      expect(await paymentStillThere("sess-busy-2")).toBe(true);
    });

    test("a crashed run's stale claim refuses the delete just the same", async () => {
      // A stale claim is still the only sign a refund may have been sent, so
      // age is no reason to destroy it.
      const attendeeId = await bookedWithPayment("sess-busy-3", "pi_busy_3");
      await putRowState(
        "sess-busy-3",
        await staleClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );
      expect(await deleteRefusal(attendeeId)).toBe(CLAIM_REFUSAL);
    });

    test("a delete is refused while the owner still has to check the payment", async () => {
      const attendeeId = await bookedWithPayment("sess-busy-4", "pi_busy_4");
      await putRowState(
        "sess-busy-4",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        "review",
      );
      expect(await deleteRefusal(attendeeId)).toBe(REVIEW_REFUSAL);
      expect(await attendeeStillThere(attendeeId)).toBe(true);
    });

    test("a payment that already ended does not hold the delete up", async () => {
      const attendeeId = await bookedWithPayment("sess-free-1", "pi_free_1");
      await putRowState(
        "sess-free-1",
        await rowStateSlot({ outcome: { error: "Card declined" } }),
        "",
      );
      expect(await deleteRefusal(attendeeId)).toBeNull();
      expect(await attendeeStillThere(attendeeId)).toBe(false);
      expect(await paymentStillThere("sess-free-1")).toBe(false);
    });

    test("an ordinary attendee is deleted as before", async () => {
      const attendeeId = await bookedWithPayment("sess-free-2", "pi_free_2");
      expect(await deleteRefusal(attendeeId)).toBeNull();
      expect(await attendeeStillThere(attendeeId)).toBe(false);
    });
  },
);
