/**
 * The maintenance write gate's migration window. While the operator's gate is
 * engaged ("true"), refuse triggers on every gated table reject writes. The
 * migration runner flips the row to "migrating" for its own batch, so its
 * writes pass. It flips the row back when the batch ends, whatever the
 * outcome. Both flips are atomic on the current value. An operator who lifts
 * the gate mid-run is therefore never overridden.
 */

import type { ResultSet } from "@libsql/client";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { syncWrittenSetting } from "#db/settings/raw-writes.ts";
import { setSnapshotField } from "#db/settings/snapshot.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

/** The row value while a migration batch runs. The refuse triggers only
 *  match "true", so this value opens every gated table for the runner. */
export const MAINTENANCE_GATE_MIGRATING = "migrating";

const flip = async (from: string, to: string): Promise<boolean> => {
  const result: ResultSet = await executeWithoutCacheInvalidation(
    "UPDATE settings SET value = ?1 WHERE key = ?2 AND value = ?3",
    [to, CONFIG_KEYS.MAINTENANCE_GATE, from],
  );
  const flipped = result.rowsAffected > 0;
  if (flipped) {
    await syncWrittenSetting(CONFIG_KEYS.MAINTENANCE_GATE, to);
    setSnapshotField("maintenance_gate", true);
  }
  return flipped;
};

/** Open the migration window: "true" becomes "migrating". False when the gate
 *  is not engaged, so a normal deploy writes nothing. */
export const openMigrationWindow = (): Promise<boolean> =>
  flip("true", MAINTENANCE_GATE_MIGRATING);

/** Close the migration window: "migrating" becomes "true" again. An operator
 *  who lifted or reset the row mid-run is never overridden. */
export const closeMigrationWindow = async (): Promise<void> => {
  await flip(MAINTENANCE_GATE_MIGRATING, "true");
};
