/** Building the stored records a refund claim reads, for tests that need a row
 *  to already be in a particular state. */

import { encrypt } from "#shared/crypto/encryption.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { mirrorFor } from "#shared/payment/admit-move.ts";
import type {
  PaymentRowState,
  RefundCapability,
} from "#shared/payment/row-state.ts";
import { writeRowState } from "#shared/payment/row-state.ts";

const SLOT = "processed_payments.failure_data";

/** The plain words the prune and the orphan purge see, read back out of the
 *  production table rather than spelled again here — so a change to either word
 *  moves every fixture and assertion with it. */
export const CLAIM_MIRROR = mirrorFor({
  claim: {
    attendeeId: 0,
    capability: "keyless",
    scope: "attendee_set",
    writtenAt: "",
  },
});
export const REVIEW_MIRROR = mirrorFor({ review: { kind: "partial_refund" } });
export const UNRECORDED_MIRROR = mirrorFor({
  unrecorded: { returnedAt: "" },
});

/** One column off a payment row, by the session that names it. Every caller
 *  has just written the row it asks about, so a missing one is a broken test
 *  rather than an outcome to branch on. */
const paymentRowColumn =
  (column: string) =>
  async (sessionId: string): Promise<string> => {
    const row = await queryOne<{ v: string }>(
      `SELECT payment.${column} AS v
         FROM processed_payments AS payment
        WHERE payment.payment_session_id = ?`,
      [sessionId],
    );
    if (row === null) throw new Error(`No payment row for ${sessionId}`);
    return row.v;
  };

/** The plain word the row shows the readers that cannot decrypt it. */
export const protectedStateOf = paymentRowColumn("protected_state");

/** The blind one-way index stored beside the row's payment reference. */
export const referenceIndexOf = paymentRowColumn("payment_reference_index");

/** Any record, encrypted the way the column stores it. */
export const rowStateSlot = (state: PaymentRowState): Promise<string> =>
  encrypt(writeRowState(state, SLOT));

/** One `attendee_set` claim's record, written the given number of milliseconds
 *  ago. Curried so "a run holding this now" and "a crashed worker's" are the
 *  same record differing only in age. */
const claimSlotWritten =
  (msAgo: number) =>
  (
    attendeeId: number,
    capability: RefundCapability = "keyless",
  ): Promise<string> =>
    rowStateSlot({
      claim: {
        attendeeId,
        capability,
        scope: "attendee_set",
        writtenAt: new Date(nowMs() - msAgo).toISOString(),
      },
    });

/** The stored record for a claim a run is holding right now. */
export const freshClaimSlot = claimSlotWritten(0);

/** The stored record for a claim written long enough ago to be a crashed
 *  worker's. */
export const staleClaimSlot = claimSlotWritten(STALE_RESERVATION_MS + 1000);

/** Put a record on an existing payment row, mirror and all, the way a claim or
 *  an owner review leaves it. */
export const putRowState = async (
  sessionId: string,
  slot: string,
  mirror: string,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments
        SET failure_data = ?, protected_state = ?
      WHERE payment_session_id = ?`,
    [slot, mirror, sessionId],
  );
};

/** Every row a claim holds, flattened. The claim keeps them per attendee so a
 *  run can let one person go while another's answer is in doubt; a test that
 *  only cares WHICH rows were held asks for them this way. */
export const heldSessionIds = (claim: {
  held: ReadonlyMap<number, readonly string[]>;
}): string[] => [...claim.held.values()].flat();
