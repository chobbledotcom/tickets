/**
 * Find stored rows whose machines form a declared impossible combination.
 * Each query is tied to one {@link ILLEGAL_JOINT_STATES} entry, phrased over
 * the plaintext mirror columns so the scan decrypts nothing: a row's live
 * work shows through `protected_state` (every claim-holding node mirrors the
 * one claim word), and a charge's state shows through `refund_state_name`.
 * The scan is the operator's view of the seam — an impossible combination
 * becomes a listed row instead of a debugging session.
 */

import type { ResultSet } from "@libsql/client";
import { queryBatch, resultRows } from "#shared/db/client.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import { ILLEGAL_JOINT_STATES } from "#shared/payment/joint-state.ts";

/** Which declared entry a found row breaks, named for the catalog. */
export type JointAnomalyKey = "armed_without_claim" | "claim_without_charge";

export interface JointAnomaly {
  readonly key: JointAnomalyKey;
  readonly sessionId: string;
}

/** Enough rows to show the problem without an unbounded read — a healthy
 * site returns none at all. */
const SCAN_LIMIT = 25;

/** The scan must cover exactly the declared entries: a new illegal
 * combination fails this lookup until the scan learns its query. */
const declaredEntry = (
  authority: string,
): (typeof ILLEGAL_JOINT_STATES)[number] => {
  const entry = ILLEGAL_JOINT_STATES.find(
    (candidate) => candidate.authority === authority,
  );
  if (entry === undefined) {
    throw new Error(`No declared illegal entry for ${authority}`);
  }
  return entry;
};

/** Scan the stored rows for every declared impossible combination. */
export const scanJointAnomalies = async (): Promise<JointAnomaly[]> => {
  // Tie each query to its declaration, so a renamed or removed entry breaks
  // the scan loudly instead of leaving a rule silently unchecked.
  declaredEntry("send_armed");
  declaredEntry("absent");
  const [armed, unbacked] = await queryBatch([
    {
      args: [CLAIM_MIRROR, SCAN_LIMIT],
      sql: `SELECT payment.payment_session_id
              FROM payment_charges AS charge
              JOIN processed_payments AS payment
                ON payment.payment_reference_index = charge.reference_index
             WHERE charge.refund_state_name = 'send_armed'
               AND payment.protected_state != ?
             LIMIT ?`,
    },
    {
      args: [CLAIM_MIRROR, SCAN_LIMIT],
      sql: `SELECT payment.payment_session_id
              FROM processed_payments AS payment
             WHERE payment.protected_state = ?
               AND NOT EXISTS (
                 SELECT 1 FROM payment_charges AS charge
                  WHERE charge.reference_index = payment.payment_reference_index
               )
             LIMIT ?`,
    },
  ]);
  const found = (
    result: ResultSet | undefined,
    key: JointAnomalyKey,
  ): JointAnomaly[] =>
    resultRows<{ payment_session_id: string }>(result!).map((row) => ({
      key,
      sessionId: row.payment_session_id,
    }));
  return [
    ...found(armed, "armed_without_claim"),
    ...found(unbacked, "claim_without_charge"),
  ];
};
