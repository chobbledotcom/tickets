import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { groups } from "#db/groups.ts";
import { listingsTable } from "#db/listings/records.ts";
import { scanSchemaAnomalies } from "#db/schema-anomaly-scan.ts";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { SQUARE_NAME_BUDGET } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantArmedCharge, plantPaymentRow } from "#test-utils/joint-state.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";

/** A listing row the write guard never saw — every name this suite plants
 *  bypasses the guarded write paths, exactly as a name stored before the
 *  guard existed does. */
const plantListingNamed = async (name: string): Promise<number> => {
  const slug = `scan-${name.length}`;
  const listing = await listingsTable.insert({
    maxAttendees: 10,
    maxPrice: 0,
    name,
    slug,
    slugIndex: await hmacHash(slug),
  });
  return listing.id;
};

/** A group row planted the same way, past the guarded write paths. */
const plantGroupNamed = async (name: string): Promise<number> => {
  const slug = `scan-group-${name.length}`;
  const group = await groups.table.insert({
    name,
    slug,
    slugIndex: await hmacHash(slug),
  });
  return group.id;
};

describeWithEnv("schema anomaly scan", { db: true }, () => {
  test("finds nothing on a clean database", async () => {
    expect(await scanSchemaAnomalies()).toEqual([]);
  });

  test("reports a stored listing name past the order-line budget", async () => {
    // Regression: a name written before the write guard exists is never
    // re-checked by a save, so the buyer keeps meeting the provider refusal.
    // The scan surfaces it to the operator instead, with the record named.
    const id = await plantListingNamed("L".repeat(SQUARE_NAME_BUDGET + 1));
    expect(await scanSchemaAnomalies()).toEqual([
      { key: "catalog_name_over_length", recordId: `listing:${id}` },
    ]);
  });

  test("reports a stored group name, and accepts one at the budget", async () => {
    const listingId = await plantListingNamed(
      "L".repeat(SQUARE_NAME_BUDGET + 1),
    );
    const groupId = await plantGroupNamed("G".repeat(SQUARE_NAME_BUDGET + 1));
    // A name exactly at the budget stays clean, so only the two planted rows
    // past it show.
    await plantListingNamed("N".repeat(SQUARE_NAME_BUDGET));
    await plantGroupNamed("M".repeat(500));

    const anomalies = await scanSchemaAnomalies();
    expect(anomalies).toContainEqual({
      key: "catalog_name_over_length",
      recordId: `group:${groupId}`,
    });
    expect(anomalies).toContainEqual({
      key: "catalog_name_over_length",
      recordId: `listing:${listingId}`,
    });
    expect(anomalies.length).toBe(2);
  });

  test("reports an armed send on a row nobody holds", async () => {
    await plantPaymentRow("cs_scan_armed", "ref_scan_armed", "");
    await plantArmedCharge("ref_scan_armed");
    expect(await scanSchemaAnomalies()).toEqual([
      {
        key: "armed_without_claim",
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
        recordId: "cs_scan_unbacked",
      },
    ]);
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
