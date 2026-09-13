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
  recoveryCheckoutIdAgrees,
  SumupRecoveryStateSchema,
} from "#payment/sumup-recovery-machine-spec.ts";

type PaymentAnomalyKey = "armed_without_claim" | "claim_without_charge";
type SumupAnomalyKey =
  | "sumup_checkout_id_mismatch"
  | "sumup_check_time_mismatch"
  | "sumup_unknown_state";

export type SchemaAnomalyKey = PaymentAnomalyKey | SumupAnomalyKey;

/** One stored row that breaks a declared rule: the rule's key, the record,
 * and the stored state word beside it when the rule judges that word. A
 * scan whose rule is carried by the record id alone sends no word. */
export type SchemaAnomaly = {
  readonly key: SchemaAnomalyKey;
  readonly recordId: string;
  readonly state?: string;
};

/** Enough rows to show the problem without an unbounded read — a healthy
 * site returns none at all. Shared by every bounded operator listing on the
 * system map. */
export const SCAN_LIMIT = 25;
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

const paymentScan = (
  key: PaymentAnomalyKey,
  sql: string,
  args: readonly (number | string)[],
): DeclaredScan =>
  declaredScan<PaymentScanRow>(sql, args, (row) => ({
    key,
    recordId: row.record_id,
  }));

/** One query per declared authority, each handed the authority's own stored
 * word to bind, so the SQL never restates a state name. The record is keyed
 * by the declaration table's own literals, so adding an illegal combination
 * is a compile error here until the scan learns how to look for it. */
const SCAN_OF: Record<
  DeclaredAuthority,
  (authority: DeclaredAuthority) => DeclaredScan
> = {
  absent: () =>
    paymentScan(
      "claim_without_charge",
      `SELECT payment.payment_session_id AS record_id
       FROM processed_payments AS payment
      WHERE payment.protected_state = ?
        AND NOT EXISTS (
          SELECT 1 FROM payment_charges AS charge
           WHERE charge.reference_index = payment.payment_reference_index
        )
      LIMIT ?`,
      [CLAIM_MIRROR, SCAN_LIMIT],
    ),
  send_armed: (authority) =>
    paymentScan(
      "armed_without_claim",
      `SELECT payment.payment_session_id AS record_id
       FROM payment_charges AS charge
       JOIN processed_payments AS payment
         ON payment.payment_reference_index = charge.reference_index
      WHERE charge.refund_state_name = ?
        AND payment.protected_state != ?
      LIMIT ?`,
      [authority, CLAIM_MIRROR, SCAN_LIMIT],
    ),
};

/** Which rule a returned SumUp row broke. The query only returns rows that
 * broke one, so a row whose word and checkout id agree is here for its
 * check time. */
const sumupAnomaly = (row: SumupScanRow): SchemaAnomaly => {
  let key: SumupAnomalyKey = "sumup_unknown_state";
  if (v.is(SumupRecoveryStateSchema, row.recovery_state)) {
    key = recoveryCheckoutIdAgrees({
      recoveryState: row.recovery_state,
      sumupId: row.sumup_id,
    })
      ? "sumup_check_time_mismatch"
      : "sumup_checkout_id_mismatch";
  }
  return { key, recordId: row.record_id, state: row.recovery_state };
};

const SUMUP_SCAN: DeclaredScan = declaredScan<SumupScanRow>(
  // The operator sees `reference_index`, a one-way code this database cannot
  // turn back into the buyer's reference. `sumup_id` only picks which fault
  // the row has, and no amount or buyer fact is selected. The word and
  // checkout-id rule is `recoveryCheckoutIdAgrees`, and the clock rule
  // mirrors the declared checkable list bound below: a checkable row carries
  // a well-formed check time, every other row carries none.
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
    ILLEGAL_JOINT_STATES.map((entry) =>
      SCAN_OF[entry.authority](entry.authority),
    ),
  );
  const scans = [...paymentScans, SUMUP_SCAN];
  const results = await queryBatch(
    scans.map((scan) => ({ args: [...scan.args], sql: scan.sql })),
  );
  return scans.flatMap((scan, index) => scan.read(results[index]!));
};
