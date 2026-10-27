import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { scanSchemaAnomalies } from "#db/schema-anomaly-scan.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

describeWithEnv("schema anomaly scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  test("reports a SumUp recovery state the machine does not know", async () => {
    await plantSumupRecoveryRow("co_scan_unknown", "abandoned", null);

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_unknown_state",
        recordId: "idx_co_scan_unknown",
        state: "abandoned",
      },
    ]);
  });

  test("reports a staged SumUp row that has a checkout id", async () => {
    await plantSumupRecoveryRow("co_scan_staged", "staged", null);

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_checkout_id_mismatch",
        recordId: "idx_co_scan_staged",
        state: "staged",
      },
    ]);
  });

  test("reports a live SumUp row that has no checkout id", async () => {
    await plantSumupRecoveryRow("co_scan_missing", "waiting", null);
    await execute(
      "UPDATE sumup_checkouts SET sumup_id = '' WHERE reference_index = ?",
      ["idx_co_scan_missing"],
    );

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_checkout_id_mismatch",
        recordId: "idx_co_scan_missing",
        state: "waiting",
      },
    ]);
  });

  test("reports a checkable SumUp row that has no check time", async () => {
    await plantSumupRecoveryRow("co_scan_no_clock", "waiting", null);

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_no_clock",
        state: "waiting",
      },
    ]);
  });

  test("reports a checkable SumUp row with an invalid check time", async () => {
    await plantSumupRecoveryRow("co_scan_bad_clock", "waiting", "not-a-date");

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_bad_clock",
        state: "waiting",
      },
    ]);
  });

  test("reports a checkable SumUp row with an invalid calendar date", async () => {
    await plantSumupRecoveryRow(
      "co_scan_bad_date",
      "waiting",
      "2026-02-30T00:00:00.000Z",
    );

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_bad_date",
        state: "waiting",
      },
    ]);
  });

  test("reports a closed SumUp row that still has a check time", async () => {
    await plantSumupRecoveryRow(
      "co_scan_closed_clock",
      "finished",
      "2999-01-01T00:00:00.000Z",
    );

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_check_time_mismatch",
        recordId: "idx_co_scan_closed_clock",
        state: "finished",
      },
    ]);
  });

  test("accepts the SumUp state that has no checkout id", async () => {
    await plantSumupRecoveryRow("", "staged", null);

    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  test("accepts a SumUp state with its checkout id", async () => {
    await plantSumupRecoveryRow(
      "co_scan_waiting",
      "waiting",
      "2999-01-01T00:00:00.000Z",
    );

    expect(await scanSchemaAnomalies()).toEqual([]);
  });
});
