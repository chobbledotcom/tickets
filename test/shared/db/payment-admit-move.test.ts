import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  orRefusal,
  PaymentRowsBusyError,
} from "#shared/db/payment-admit-move.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
  staleClaimSlot,
} from "#test-utils/payment-claim.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";

const CLAIM_REFUSAL =
  "A refund for this person is still in progress. Finish or re-run the refund, then try again.";
const REVIEW_REFUSAL =
  "The owner still has to check a payment for this person. Mark it reviewed, then try again.";

/** What a refused delete says, or null when it went through. */
const deleteRefusal = async (attendeeId: number): Promise<string | null> => {
  try {
    await deleteAttendee(attendeeId);
    return null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
};

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
        REVIEW_MIRROR,
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

describe("answering a writer that could not go ahead", () => {
  test("a busy-rows refusal becomes the operator's message", async () => {
    expect(
      await orRefusal(
        () => Promise.reject(new PaymentRowsBusyError("still refunding")),
        (message) => message,
      ),
    ).toBe("still refunding");
  });

  // Only the busy-rows refusal is an answer. Anything else going wrong in the
  // transaction is a real failure, and turning it into an operator message
  // would report a broken write as a polite "try again later".
  test("any other failure is raised, not turned into a message", async () => {
    await expect(
      orRefusal(
        () => Promise.reject(new Error("the database fell over")),
        () => "refused",
      ),
    ).rejects.toThrow("the database fell over");
  });
});
