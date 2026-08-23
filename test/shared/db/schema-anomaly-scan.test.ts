import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { scanSchemaAnomalies } from "#db/schema-anomaly-scan.ts";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantArmedCharge, plantPaymentRow } from "#test-utils/joint-state.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

describeWithEnv("schema anomaly scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  test("reports an armed send on a row nobody holds", async () => {
    await plantPaymentRow("cs_scan_armed", "ref_scan_armed", "");
    await plantArmedCharge("ref_scan_armed");
    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "armed_without_claim",
        kind: "payment",
        recordId: "cs_scan_armed",
      },
    ]);
  });

  test("says nothing about an armed send under a held claim", async () => {
    await plantPaymentRow("cs_scan_held", "ref_scan_held", CLAIM_MIRROR);
    await plantArmedCharge("ref_scan_held");
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  test("reports a held row whose payment has no charge", async () => {
    await plantPaymentRow("cs_scan_unbacked", "ref_scan_none", CLAIM_MIRROR);
    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "claim_without_charge",
        kind: "payment",
        recordId: "cs_scan_unbacked",
      },
    ]);
  });

  test("reports a SumUp recovery state the machine does not know", async () => {
    await plantSumupRecoveryRow("co_scan_unknown", "abandoned", null);

    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "sumup_unknown_state",
        kind: "sumup",
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
        kind: "sumup",
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
        kind: "sumup",
        recordId: "idx_co_scan_missing",
        state: "waiting",
      },
    ]);
  });

  test("accepts SumUp rows whose states and checkout ids agree", async () => {
    await plantSumupRecoveryRow("", "staged", null);
    await plantSumupRecoveryRow("co_scan_waiting", "waiting", null);

    expect(await scanSchemaAnomalies()).toEqual([]);
  });
});
