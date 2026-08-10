/** Building the stored records a refund claim reads, for tests that need a row
 *  to already be in a particular state. */

import { encrypt } from "#shared/crypto/encryption.ts";
import { execute } from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import type {
  PaymentRowState,
  RefundCapability,
} from "#shared/payment/row-state.ts";
import { writeRowState } from "#shared/payment/row-state.ts";

const SLOT = "processed_payments.failure_data";

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
