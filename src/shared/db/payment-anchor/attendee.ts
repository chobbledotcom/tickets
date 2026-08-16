/** Durable refund identity attached to an attendee. */

import { inPlaceholders, type SqlStatement } from "#shared/db/client.ts";
import {
  paymentRowStateValues,
  type RowSettlement,
} from "#shared/db/payment-claim.ts";
import { nowIso } from "#shared/now.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { EMPTY_ROW_STATE } from "#shared/payment/row-state.ts";
import {
  checkingClaimFor,
  grantClaim,
} from "#shared/payment/row-transitions.ts";
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

/** Prepare one payment reference and its destructive-write fence together. */
export const prepareClaimedAttendeePaymentAnchor = async (
  payment: TaggedPaymentReference,
): Promise<PreparedClaimedAttendeePaymentAnchor> => {
  const { matchingIndexes, stored } = await paymentAnchorReference(payment);
  const matchingIndexSlots = inPlaceholders(matchingIndexes);
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
      grantClaim(EMPTY_ROW_STATE, claim),
    );
    return {
      sessionId,
      settlement: {
        commandId,
        heldSince,
        rows: new Map([[sessionId, { claim: "release", phase: "checking" }]]),
      },
      statement: {
        args: [
          sessionId,
          attendeeId,
          heldSince,
          stored.encrypted,
          stored.index,
          state.failureData,
          state.protectedState,
          attendeeId,
          attendeeId,
          ...matchingIndexes,
        ],
        sql: `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, payment_reference,
             payment_reference_index, failure_data, protected_state)
          SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM attendees AS attendee WHERE attendee.id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM processed_payments AS payment
                WHERE payment.attendee_id = ?
                  AND payment.payment_reference_index IN (${matchingIndexSlots})
             )`,
      },
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
