import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  type SchemaAnomalyKey,
  scanSchemaAnomalies,
} from "#db/schema-anomaly-scan.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

/** The case name, the rule its scan must report, and the planted row. The
 *  anomaly names the row it came from, so the rule plus the row give the
 *  whole expectation. */
type ScanCase = [
  title: string,
  /** The rule the planted row breaks. A `null` rule expects a clean scan. */
  brokenRule: SchemaAnomalyKey | null,
  /** The planted recovery row: checkout id, state word, check time. */
  row: [id: string, state: string, nextCheckAt: string | null],
  /** The row's checkout id was never written back, so it reads as empty. */
  checkoutIdCleared?: boolean,
];

/** Each planted row and the rule its scan must report for it. A row whose
 *  state word and checkout id agree is reported for its check time. A
 *  matching pair reports nothing. */
const scanCases: ScanCase[] = [
  [
    "reports a SumUp recovery state the machine does not know",
    "sumup_unknown_state",
    ["co_scan_unknown", "abandoned", null],
  ],
  [
    "reports a staged SumUp row that has a checkout id",
    "sumup_checkout_id_mismatch",
    ["co_scan_staged", "staged", null],
  ],
  [
    "reports a live SumUp row that has no checkout id",
    "sumup_checkout_id_mismatch",
    ["co_scan_missing", "waiting", null],
    true,
  ],
  [
    "reports a checkable SumUp row that has no check time",
    "sumup_check_time_mismatch",
    ["co_scan_no_clock", "waiting", null],
  ],
  [
    "reports a checkable SumUp row with an invalid check time",
    "sumup_check_time_mismatch",
    ["co_scan_bad_clock", "waiting", "not-a-date"],
  ],
  [
    "reports a checkable SumUp row with an invalid calendar date",
    "sumup_check_time_mismatch",
    ["co_scan_bad_date", "waiting", "2026-02-30T00:00:00.000Z"],
  ],
  [
    "reports a closed SumUp row that still has a check time",
    "sumup_check_time_mismatch",
    ["co_scan_closed_clock", "finished", "2999-01-01T00:00:00.000Z"],
  ],
  [
    "accepts the SumUp state that has no checkout id",
    null,
    ["", "staged", null],
  ],
  [
    "accepts a SumUp state with its checkout id",
    null,
    ["co_scan_waiting", "waiting", "2999-01-01T00:00:00.000Z"],
  ],
];

describeWithEnv("schema anomaly scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  for (const [title, brokenRule, row, checkoutIdCleared] of scanCases) {
    test(title, async () => {
      await plantSumupRecoveryRow(...row);
      if (checkoutIdCleared === true) {
        await execute(
          sql`UPDATE sumup_checkouts SET sumup_id = '' WHERE reference_index = ${`idx_${row[0]}`}`,
        );
      }

      expect(await scanSchemaAnomalies()).toEqual(
        brokenRule === null
          ? []
          : [{ key: brokenRule, recordId: `idx_${row[0]}`, state: row[1] }],
      );
    });
  }
});
