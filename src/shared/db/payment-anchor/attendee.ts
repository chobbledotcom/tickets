/** Durable refund identity attached to an attendee. */

import type { SqlStatement } from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  paymentRowStateValues,
  type RowSettlement,
} from "#db/payment-claim.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { EMPTY_ROW_STATE } from "#payment/row-state.ts";
import { checkingClaimFor, grantClaim } from "#payment/row-transitions.ts";
import { nowIso } from "#shared/now.ts";
import { paymentAnchorReference } from "./reference.ts";
import { anchorSessionId } from "./session.ts";

export interface ClaimedAttendeePaymentAnchor {
  readonly sessionId: string;
  readonly settlement: RowSettlement;
  readonly statement: SqlStatement;
}

export interface PreparedClaimedAttendeePaymentAnchor {
  readonly forAttendee: (
    attendeeId: number,
  ) => Promise<ClaimedAttendeePaymentAnchor>;
}

/** Prepare one payment reference and its destructive-write fence together.
 * When the money already came back before this row is born — the rejected
 * charge flow refunds first — `unrecordedAt` stamps that truth on the row
 * from its first write, so a crash before the books catch up leaves a state
 * every scan and route already understands. */
export const prepareClaimedAttendeePaymentAnchor = async (
  payment: TaggedPaymentReference,
  unrecordedAt?: string,
): Promise<PreparedClaimedAttendeePaymentAnchor> => {
  const { matchingIndexes, stored } = await paymentAnchorReference(payment);
  const commandId = crypto.randomUUID();
  const heldSince = nowIso();
  const sessionIdFor = (attendeeId: number): string =>
    anchorSessionId(attendeeId, stored.index);
  let boundAttendeeId: number | undefined;
  const buildFor = async (
    attendeeId: number,
  ): Promise<ClaimedAttendeePaymentAnchor> => {
    const sessionId = sessionIdFor(attendeeId);
    const claim = checkingClaimFor(
      { attendeeIds: [attendeeId], scope: "attendee_set" },
      commandId,
      heldSince,
    );
    const state = await paymentRowStateValues(
      grantClaim(
        unrecordedAt === undefined
          ? EMPTY_ROW_STATE
          : { unrecorded: { returnedAt: unrecordedAt } },
        claim,
      ),
    );
    return {
      sessionId,
      settlement: {
        commandId,
        heldSince,
        rows: new Map([[sessionId, { claim: "release", phase: "checking" }]]),
      },
      statement: numberedStatement((bind) => {
        const attendee = bind(attendeeId);
        const storedIndex = bind(stored.index);
        const matchingIndexSlots = matchingIndexes
          .map((index) => (index === stored.index ? storedIndex : bind(index)))
          .join(", ");
        return `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, payment_reference,
             payment_reference_index, failure_data, protected_state)
          SELECT ${bind(sessionId)}, ${attendee}, ${bind(heldSince)}, ${bind(stored.encrypted)},
                 ${storedIndex}, ${bind(state.failureData)}, ${bind(state.protectedState)}
           WHERE EXISTS (
             SELECT 1 FROM attendees AS attendee WHERE attendee.id = ${attendee}
           )
              AND NOT EXISTS (
                SELECT 1 FROM processed_payments AS payment
                WHERE payment.attendee_id = ${attendee}
                  AND payment.payment_reference_index IN (${matchingIndexSlots})
              )`;
      }),
    };
  };
  return {
    forAttendee: (attendeeId) => {
      if (boundAttendeeId !== undefined) {
        throw new Error(
          `Payment anchor was already bound to attendee ${boundAttendeeId}`,
        );
      }
      boundAttendeeId = attendeeId;
      return buildFor(attendeeId);
    },
  };
};
