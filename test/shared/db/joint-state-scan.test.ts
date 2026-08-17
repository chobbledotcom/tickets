import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { scanJointAnomalies } from "#shared/db/joint-state-scan.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantArmedCharge, plantPaymentRow } from "#test-utils/joint-state.ts";

describeWithEnv("joint-state scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanJointAnomalies()).toEqual([]);
  });

  test("reports an armed send on a row nobody holds", async () => {
    await plantPaymentRow("cs_scan_armed", "ref_scan_armed", "");
    await plantArmedCharge("ref_scan_armed");
    expect(await scanJointAnomalies()).toEqual([
      { key: "armed_without_claim", sessionId: "cs_scan_armed" },
    ]);
  });

  test("says nothing about an armed send under a held claim", async () => {
    await plantPaymentRow("cs_scan_held", "ref_scan_held", CLAIM_MIRROR);
    await plantArmedCharge("ref_scan_held");
    expect(await scanJointAnomalies()).toEqual([]);
  });

  test("reports a held row whose payment has no charge", async () => {
    await plantPaymentRow("cs_scan_unbacked", "ref_scan_none", CLAIM_MIRROR);
    expect(await scanJointAnomalies()).toEqual([
      { key: "claim_without_charge", sessionId: "cs_scan_unbacked" },
    ]);
  });
});
