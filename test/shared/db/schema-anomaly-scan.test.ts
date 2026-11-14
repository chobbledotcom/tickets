import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  type SchemaAnomaly,
  scanSchemaAnomalies,
} from "#db/schema-anomaly-scan.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

type ScanCase = {
  title: string;
  /** The planted recovery row: checkout id, state word, check time. */
  row: [id: string, state: string, nextCheckAt: string | null];
  /** The row's checkout id was never written back, so it reads as empty. */
  checkoutIdCleared?: true;
  expected: SchemaAnomaly[];
};

/** Each planted row and the anomalies its scan must report. A row whose state
 *  word and checkout id agree is reported for its check time; a matching pair
 *  reports nothing. */
const scanCases: ScanCase[] = [
  {
    expected: [
      {
        key: "sumup_unknown_state",
        recordId: "idx_co_scan_unknown",
        state: "abandoned",
      },
    ],
    row: ["co_scan_unknown", "abandoned", null],
    title: "reports a SumUp recovery state the machine does not know",
  },
  {
    expected: [
      {
        key: "sumup_checkout_id_mismatch",
        recordId: "idx_co_scan_staged",
        state: "staged",
      },
    ],
    row: ["co_scan_staged", "staged", null],
    title: "reports a staged SumUp row that has a checkout id",
  },
  {
    checkoutIdCleared: true,
    expected: [
      {
        key: "sumup_checkout_id_mismatch",
        recordId: "idx_co_scan_missing",
        state: "waiting",
      },
    ],
    row: ["co_scan_missing", "waiting", null],
    title: "reports a live SumUp row that has no checkout id",
  },
  {
    expected: [
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_no_clock",
        state: "waiting",
      },
    ],
    row: ["co_scan_no_clock", "waiting", null],
    title: "reports a checkable SumUp row that has no check time",
  },
  {
    expected: [
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_bad_clock",
        state: "waiting",
      },
    ],
    row: ["co_scan_bad_clock", "waiting", "not-a-date"],
    title: "reports a checkable SumUp row with an invalid check time",
  },
  {
    expected: [
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_bad_date",
        state: "waiting",
      },
    ],
    row: ["co_scan_bad_date", "waiting", "2026-02-30T00:00:00.000Z"],
    title: "reports a checkable SumUp row with an invalid calendar date",
  },
  {
    expected: [
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_closed_clock",
        state: "finished",
      },
    ],
    row: ["co_scan_closed_clock", "finished", "2999-01-01T00:00:00.000Z"],
    title: "reports a closed SumUp row that still has a check time",
  },
  {
    expected: [],
    row: ["", "staged", null],
    title: "accepts the SumUp state that has no checkout id",
  },
  {
    expected: [],
    row: ["co_scan_waiting", "waiting", "2999-01-01T00:00:00.000Z"],
    title: "accepts a SumUp state with its checkout id",
  },
];

describeWithEnv("schema anomaly scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  for (const { checkoutIdCleared, expected, row, title } of scanCases) {
    test(title, async () => {
      await plantSumupRecoveryRow(...row);
      if (checkoutIdCleared === true) {
        await execute(
          sql`UPDATE sumup_checkouts SET sumup_id = '' WHERE reference_index = ${`idx_${row[0]}`}`,
        );
      }

      expect(await scanSchemaAnomalies()).toEqual(expected);
    });
  }
});
