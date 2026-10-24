/** Find stored rows that do not fit their declared machine rules. */

import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { inPlaceholders, queryAllPrimary } from "#db/client.ts";
import {
  RECOVERY_CHECKABLE_NODES,
  RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
  recoveryCheckoutIdAgrees,
  SumupRecoveryStateSchema,
} from "#payment/sumup-recovery-machine-spec.ts";

type SumupAnomalyKey =
  | "sumup_checkout_id_mismatch"
  | "sumup_check_time_mismatch"
  | "sumup_unknown_state";

export type SchemaAnomalyKey = SumupAnomalyKey;

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

interface SumupScanRow {
  readonly record_id: string;
  readonly recovery_state: string;
  readonly sumup_id: string;
}

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

// The operator sees `reference_index`, a one-way code this database cannot
// turn back into the buyer's reference. `sumup_id` only picks which fault
// the row has, and no amount or buyer fact is selected. The word and
// checkout-id rule is `recoveryCheckoutIdAgrees`, and the clock rule mirrors
// the declared checkable list bound below: a checkable row carries a
// well-formed check time, every other row carries none.
const SUMUP_SCAN_SQL = `SELECT reference_index AS record_id, recovery_state, sumup_id
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
         LIMIT ?`;

const SUMUP_SCAN_ARGS: InValue[] = [
  ...SumupRecoveryStateSchema.options,
  RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
  ...RECOVERY_CHECKABLE_NODES,
  SCAN_LIMIT,
];

/** Scan the stored rows for every declared impossible state. */
export const scanSchemaAnomalies = async (): Promise<SchemaAnomaly[]> =>
  (
    await queryAllPrimary<SumupScanRow>({
      args: SUMUP_SCAN_ARGS,
      sql: SUMUP_SCAN_SQL,
    })
  ).map(sumupAnomaly);
