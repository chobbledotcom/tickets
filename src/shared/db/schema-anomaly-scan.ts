/** Find stored rows that do not fit their declared machine rules. */

import * as v from "valibot";
import { queryBatch, resultRows } from "#db/client.ts";
import { uniqueBy } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { ILLEGAL_JOINT_STATES } from "#payment/joint-state.ts";
import {
  RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
  SumupRecoveryStateSchema,
} from "#payment/sumup-recovery-machine-spec.ts";

type PaymentAnomalyKey = "armed_without_claim" | "claim_without_charge";
type SumupAnomalyKey = "sumup_checkout_id_mismatch" | "sumup_unknown_state";

export type SchemaAnomaly =
  | {
      readonly key: PaymentAnomalyKey;
      readonly kind: "payment";
      readonly recordId: string;
    }
  | {
      readonly key: SumupAnomalyKey;
      readonly kind: "sumup";
      readonly recordId: string;
      readonly state: string;
    };

/** Enough rows to show the problem without an unbounded read — a healthy
 * site returns none at all. */
const SCAN_LIMIT = 25;
const SUMUP_STATE_SLOTS = SumupRecoveryStateSchema.options
  .map(() => "?")
  .join(", ");

type DeclaredAuthority = (typeof ILLEGAL_JOINT_STATES)[number]["authority"];

interface DeclaredScan {
  readonly anomalyOf: (row: ScanRow) => SchemaAnomaly;
  readonly args: readonly (number | string)[];
  readonly sql: string;
}

interface ScanRow {
  readonly record_id: string;
  readonly recovery_state: string;
}

const paymentAnomaly =
  (key: PaymentAnomalyKey) =>
  (row: ScanRow): SchemaAnomaly => ({
    key,
    kind: "payment",
    recordId: row.record_id,
  });

/** One query per declared authority. The record is keyed by the declaration
 * table's own literals, so adding an illegal combination is a compile error
 * here until the scan learns how to look for it. */
const SCAN_OF: Record<DeclaredAuthority, DeclaredScan> = {
  absent: {
    anomalyOf: paymentAnomaly("claim_without_charge"),
    args: [CLAIM_MIRROR, SCAN_LIMIT],
    sql: `SELECT payment.payment_session_id AS record_id,
                 '' AS recovery_state
            FROM processed_payments AS payment
           WHERE payment.protected_state = ?
             AND NOT EXISTS (
               SELECT 1 FROM payment_charges AS charge
                WHERE charge.reference_index = payment.payment_reference_index
             )
           LIMIT ?`,
  },
  send_armed: {
    anomalyOf: paymentAnomaly("armed_without_claim"),
    args: [CLAIM_MIRROR, SCAN_LIMIT],
    sql: `SELECT payment.payment_session_id AS record_id,
                 '' AS recovery_state
            FROM payment_charges AS charge
            JOIN processed_payments AS payment
              ON payment.payment_reference_index = charge.reference_index
           WHERE charge.refund_state_name = 'send_armed'
             AND payment.protected_state != ?
           LIMIT ?`,
  },
};

const sumupAnomaly = (row: ScanRow): SchemaAnomaly => ({
  key: v.is(SumupRecoveryStateSchema, row.recovery_state)
    ? "sumup_checkout_id_mismatch"
    : "sumup_unknown_state",
  kind: "sumup",
  recordId: row.record_id,
  state: row.recovery_state,
});

const SUMUP_SCAN: DeclaredScan = {
  anomalyOf: sumupAnomaly,
  args: [
    ...SumupRecoveryStateSchema.options,
    RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
    SCAN_LIMIT,
  ],
  sql: `SELECT reference_index AS record_id, recovery_state
          FROM sumup_checkouts
         WHERE recovery_state NOT IN (${SUMUP_STATE_SLOTS})
            OR (recovery_state = ?) != (sumup_id = '')
         LIMIT ?`,
};

/** Scan the stored rows for every declared impossible state. */
export const scanSchemaAnomalies = async (): Promise<SchemaAnomaly[]> => {
  const paymentScans = uniqueBy((scan: DeclaredScan) => scan.sql)(
    ILLEGAL_JOINT_STATES.map((entry) => SCAN_OF[entry.authority]),
  );
  const scans = [...paymentScans, SUMUP_SCAN];
  const results = await queryBatch(
    scans.map((scan) => ({ args: [...scan.args], sql: scan.sql })),
  );
  return scans.flatMap((scan, index) =>
    resultRows<ScanRow>(results[index]!).map(scan.anomalyOf),
  );
};
