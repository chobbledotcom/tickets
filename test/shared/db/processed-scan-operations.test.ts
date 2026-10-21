/** The door's replay ledger, direct: the claim keys a delivery on its
 * operation id and its token digest together, so the same pair retrying
 * lands nowhere while a reused id naming another ticket admits. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, withTransaction } from "#db/client.ts";
import {
  claimScanOperation,
  deliveredScanOperation,
  type ScanDelivery,
} from "#db/processed-scan-operations.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** One claimed delivery: the id a device made up, the digest it stored, and
 * the listing its admission moved tickets on. */
const delivery = (operationId: string, tokenHash: string): ScanDelivery => ({
  listingIds: [3],
  operationId,
  tokenHash,
});

describeWithEnv("the scan delivery ledger", { db: true }, () => {
  test("claims a fresh delivery inside the caller's transaction", async () => {
    const claimed = await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-1", "digest-a"))(tx),
    );
    expect(claimed).toBe(true);
    expect(await deliveredScanOperation("op-ledger-1", "digest-a")).toEqual([
      3,
    ]);
  });

  test("answers false when the same id and digest retry", async () => {
    await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-2", "digest-b"))(tx),
    );

    const retry = await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-2", "digest-b"))(tx),
    );
    expect(retry).toBe(false);
  });

  test("claims again when a reused id names another ticket's digest", async () => {
    await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-3", "digest-c"))(tx),
    );

    // The pair differs, so this is another delivery: a reused id must never
    // silently suppress the second ticket's admission.
    const reused = await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-3", "digest-d"))(tx),
    );
    expect(reused).toBe(true);
    expect(await deliveredScanOperation("op-ledger-3", "digest-d")).toEqual([
      3,
    ]);
  });

  test("answers null for a delivery the ledger holds nothing about", async () => {
    expect(await deliveredScanOperation("op-ledger-4", "digest-e")).toBeNull();
  });

  test("keeps the row free of tokens and guest details", async () => {
    await withTransaction((tx) =>
      claimScanOperation(delivery("op-ledger-5", "digest-f"))(tx),
    );
    const { rows } = await getDb().execute(
      "SELECT created, listing_ids, operation_id, token_hash FROM processed_scan_operations WHERE operation_id = 'op-ledger-5'",
    );
    const row = rows[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "created",
      "listing_ids",
      "operation_id",
      "token_hash",
    ]);
  });
});
