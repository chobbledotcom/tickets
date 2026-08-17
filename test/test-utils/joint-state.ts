import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { queryAll } from "#shared/db/client.ts";
import { paymentClaimRowsSql } from "#shared/db/payment-claim.ts";
import {
  assertJointStateLegal,
  authorityFactOf,
  jointRowFactOf,
} from "#shared/payment/joint-state.ts";
import { readRowState } from "#shared/payment/row-state.ts";

interface JointRow {
  attendee_id: number | null;
  failure_data: EnvKeyEncrypted | "";
  payment_session_id: string;
  refund_state_name: string | null;
}

/** The session's own row plus every row sharing its payment reference — a
 * placeholder keeps its pending outcome on the session row and its claim on
 * the anchor row, and both belong to the same crash picture. */
const SESSION_AND_SIBLINGS = `payment.payment_session_id = ?
   OR (payment.payment_reference_index != ''
       AND payment.payment_reference_index IN (
         SELECT sibling.payment_reference_index
           FROM processed_payments AS sibling
          WHERE sibling.payment_session_id = ?))`;

/**
 * Load every stored machine one session touches and prove each row's
 * combination is one a flow can produce. Crash tests call this right after
 * manufacturing their crash, so every manufactured intermediate state also
 * witnesses the seam between the machines — a crash state the seam calls
 * impossible fails the test that made it.
 */
export const expectLegalJointStates = async (
  sessionId: string,
  context: string,
): Promise<void> => {
  const rows = await queryAll<JointRow>(
    paymentClaimRowsSql(SESSION_AND_SIBLINGS),
    [sessionId, sessionId],
  );
  if (rows.length === 0) {
    throw new Error(`No payment rows to witness for ${context}`);
  }
  for (const [id, group] of Map.groupBy(
    rows,
    (row) => row.payment_session_id,
  )) {
    const first = group[0]!;
    const state =
      first.failure_data === ""
        ? {}
        : readRowState(
            await decrypt(first.failure_data),
            "processed_payments.failure_data",
          );
    assertJointStateLegal(
      jointRowFactOf(state, first.attendee_id !== null),
      group.map((row) => authorityFactOf(row.refund_state_name)),
      `${context} (row ${id})`,
    );
  }
};
