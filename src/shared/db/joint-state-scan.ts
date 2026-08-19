/**
 * Find stored rows whose machines form a declared impossible combination.
 * Each query is phrased over the plaintext mirror columns so the scan
 * decrypts nothing: a row's live work shows through `protected_state` (every
 * claim-holding node mirrors the one claim word), and a charge's state shows
 * through `refund_state_name`. The scan is the operator's view of the seam —
 * an impossible combination becomes a listed row instead of a debugging
 * session.
 */

import { queryBatch, resultRows } from "#db/client.ts";
import { uniqueBy } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { ILLEGAL_JOINT_STATES } from "#payment/joint-state.ts";

/** Which declared entry a found row breaks, named for the catalog. */
export type JointAnomalyKey = "armed_without_claim" | "claim_without_charge";

export interface JointAnomaly {
  readonly key: JointAnomalyKey;
  readonly sessionId: string;
}

/** Enough rows to show the problem without an unbounded read — a healthy
 * site returns none at all. */
const SCAN_LIMIT = 25;

type DeclaredAuthority = (typeof ILLEGAL_JOINT_STATES)[number]["authority"];

interface DeclaredScan {
  readonly key: JointAnomalyKey;
  readonly sql: string;
}

/** One query per declared authority. The record is keyed by the declaration
 * table's own literals, so adding an illegal combination is a compile error
 * here until the scan learns how to look for it. */
const SCAN_OF: Record<DeclaredAuthority, DeclaredScan> = {
  absent: {
    key: "claim_without_charge",
    sql: `SELECT payment.payment_session_id
            FROM processed_payments AS payment
           WHERE payment.protected_state = ?
             AND NOT EXISTS (
               SELECT 1 FROM payment_charges AS charge
                WHERE charge.reference_index = payment.payment_reference_index
             )
           LIMIT ?`,
  },
  send_armed: {
    key: "armed_without_claim",
    sql: `SELECT payment.payment_session_id
            FROM payment_charges AS charge
            JOIN processed_payments AS payment
              ON payment.payment_reference_index = charge.reference_index
           WHERE charge.refund_state_name = 'send_armed'
             AND payment.protected_state != ?
           LIMIT ?`,
  },
};

/** Scan the stored rows for every declared impossible combination. */
export const scanJointAnomalies = async (): Promise<JointAnomaly[]> => {
  const scans = uniqueBy((scan: DeclaredScan) => scan.key)(
    ILLEGAL_JOINT_STATES.map((entry) => SCAN_OF[entry.authority]),
  );
  const results = await queryBatch(
    scans.map((scan) => ({ args: [CLAIM_MIRROR, SCAN_LIMIT], sql: scan.sql })),
  );
  return scans.flatMap((scan, index) =>
    resultRows<{ payment_session_id: string }>(results[index]!).map((row) => ({
      key: scan.key,
      sessionId: row.payment_session_id,
    })),
  );
};
