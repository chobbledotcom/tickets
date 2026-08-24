/** Find stored rows that do not fit their declared machine rules. */

import type { ResultSet } from "@libsql/client";
import * as v from "valibot";
import { inPlaceholders, queryBatch, resultRows } from "#db/client.ts";
import { uniqueBy } from "#fp";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { ILLEGAL_JOINT_STATES } from "#payment/joint-state.ts";
import {
  RECOVERY_CHECKABLE_NODES,
  RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
  SumupRecoveryStateSchema,
} from "#payment/sumup-recovery-machine-spec.ts";

type PaymentAnomalyKey = "armed_without_claim" | "claim_without_charge";
type SumupAnomalyKey =
  | "sumup_checkout_id_mismatch"
  | "sumup_check_time_mismatch"
  | "sumup_unknown_state";

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
const SUMUP_STATE_SLOTS = inPlaceholders(SumupRecoveryStateSchema.options);
const SUMUP_CHECKABLE_SLOTS = inPlaceholders(RECOVERY_CHECKABLE_NODES);

type DeclaredAuthority = (typeof ILLEGAL_JOINT_STATES)[number]["authority"];

/** One declared impossibility and the query that finds it. Each scan reads
 * its own rows, so a query never selects a column it does not need to make
 * another scan's shape fit. */
interface DeclaredScan {
  readonly args: readonly (number | string)[];
  readonly read: (result: ResultSet) => SchemaAnomaly[];
  readonly sql: string;
}

const declaredScan = <Row>(
  sql: string,
  args: readonly (number | string)[],
  anomalyOf: (row: Row) => SchemaAnomaly,
): DeclaredScan => ({
  args,
  read: (result) => resultRows<Row>(result).map(anomalyOf),
  sql,
});

interface PaymentScanRow {
  readonly record_id: string;
}

interface SumupScanRow {
  readonly record_id: string;
  readonly recovery_state: string;
  readonly sumup_id: string;
}

const paymentScan = (key: PaymentAnomalyKey, sql: string): DeclaredScan =>
  declaredScan<PaymentScanRow>(sql, [CLAIM_MIRROR, SCAN_LIMIT], (row) => ({
    key,
    kind: "payment",
    recordId: row.record_id,
  }));

/** One query per declared authority. The record is keyed by the declaration
 * table's own literals, so adding an illegal combination is a compile error
 * here until the scan learns how to look for it. */
const SCAN_OF: Record<DeclaredAuthority, DeclaredScan> = {
  absent: paymentScan(
    "claim_without_charge",
    `SELECT payment.payment_session_id AS record_id
       FROM processed_payments AS payment
      WHERE payment.protected_state = ?
        AND NOT EXISTS (
          SELECT 1 FROM payment_charges AS charge
           WHERE charge.reference_index = payment.payment_reference_index
        )
      LIMIT ?`,
  ),
  send_armed: paymentScan(
    "armed_without_claim",
    `SELECT payment.payment_session_id AS record_id
       FROM payment_charges AS charge
       JOIN processed_payments AS payment
         ON payment.payment_reference_index = charge.reference_index
      WHERE charge.refund_state_name = 'send_armed'
        AND payment.protected_state != ?
      LIMIT ?`,
  ),
};

const sumupAnomaly = (row: SumupScanRow): SchemaAnomaly => {
  let key: SumupAnomalyKey = "sumup_unknown_state";
  if (v.is(SumupRecoveryStateSchema, row.recovery_state)) {
    const hasCheckoutId = row.sumup_id !== "";
    key =
      hasCheckoutId ===
      (row.recovery_state === RECOVERY_STATE_WITHOUT_CHECKOUT_ID)
        ? "sumup_checkout_id_mismatch"
        : "sumup_check_time_mismatch";
  }
  return {
    key,
    kind: "sumup",
    recordId: row.record_id,
    state: row.recovery_state,
  };
};

const SUMUP_SCAN: DeclaredScan = declaredScan<SumupScanRow>(
  `SELECT reference_index AS record_id, recovery_state, sumup_id
          FROM sumup_checkouts
         WHERE recovery_state NOT IN (${SUMUP_STATE_SLOTS})
            OR (recovery_state = ?) != (sumup_id = '')
            OR CASE WHEN recovery_state IN (${SUMUP_CHECKABLE_SLOTS})
                 THEN next_check_at IS NULL OR
                      strftime(
                        '%Y-%m-%dT%H:%M:%fZ', next_check_at, '+0 seconds'
                      )
                        IS NOT next_check_at
                 ELSE next_check_at IS NOT NULL
               END
         LIMIT ?`,
  [
    ...SumupRecoveryStateSchema.options,
    RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
    ...RECOVERY_CHECKABLE_NODES,
    SCAN_LIMIT,
  ],
  sumupAnomaly,
);

/** Scan the stored rows for every declared impossible state. */
export const scanSchemaAnomalies = async (): Promise<SchemaAnomaly[]> => {
  const paymentScans = uniqueBy((scan: DeclaredScan) => scan.sql)(
    ILLEGAL_JOINT_STATES.map((entry) => SCAN_OF[entry.authority]),
  );
  const scans = [...paymentScans, SUMUP_SCAN];
  const results = await queryBatch(
    scans.map((scan) => ({ args: [...scan.args], sql: scan.sql })),
  );
  return scans.flatMap((scan, index) => scan.read(results[index]!));
};
