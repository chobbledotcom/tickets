/** Building the stored records a refund claim reads, for tests that need a row
 *  to already be in a particular state. */

import { encrypt } from "#shared/crypto/encryption.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { writeRowState } from "#shared/payment/row-state.ts";

/** The stored record for a claim written long enough ago to be a crashed
 *  worker's. */
export const staleClaimSlot = async (
  attendeeId: number,
  capability: RefundCapability = "keyless",
): Promise<string> =>
  await encrypt(
    writeRowState(
      {
        claim: {
          attendeeId,
          capability,
          scope: "attendee_set",
          writtenAt: new Date(
            nowMs() - STALE_RESERVATION_MS - 1000,
          ).toISOString(),
        },
      },
      "processed_payments.failure_data",
    ),
  );
