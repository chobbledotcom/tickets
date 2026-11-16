/** Durable refund identity attached to an attendee. */

import {
  paymentRowStateValues,
  type RowSettlement,
} from "#db/payment-claim.ts";
import { rowsById } from "#db/record-table.ts";
import { and, not } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
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
 * When the money already came back before this row is born, `unrecordedAt`
 * stamps that truth on the row from its first write. The rejected charge
 * flow refunds first. A crash before the books catch up then leaves a state
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
      statement: insertInto(
        tables.processed_payments,
        {
          attendee_id: attendeeId,
          failure_data: state.failureData,
          payment_reference: stored.encrypted,
          payment_reference_index: stored.index,
          payment_session_id: sessionId,
          processed_at: heldSince,
          protected_state: state.protectedState,
        },
        {
          when: and(
            rowsById(tables.attendees, attendeeId).exists(),
            not(
              from(tables.processed_payments)
                .as("payment")
                .where({
                  attendee_id: attendeeId,
                  payment_reference_index: matchingIndexes,
                })
                .exists(),
            ),
          ),
        },
      ),
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
