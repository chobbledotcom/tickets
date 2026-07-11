import { SCHEMA } from "./schema/index.ts";
import type { MigrationContext, SchemaRequirement } from "./types.ts";

/** The unique booking-slot index on `listing_attendees`. Widening it (adding a
 * column to its identity) means DROP + recreate: `syncIndexes` never alters a
 * same-named index whose columns changed, so a widening migration drops the
 * old index first and lets the (updated) SCHEMA recreate it. */
export const SLOT_INDEX = "idx_listing_attendees_listing_attendee_start";

/** The requirement an index-only widening migration declares and verifies. */
export const SLOT_INDEX_REQUIREMENT: SchemaRequirement = {
  indexes: [SLOT_INDEX],
};

/** Drop the booking-slot index and resync so the SCHEMA's current definition
 * (with any newly added identity column) is what exists afterwards. */
export const recreateSlotIndex = async ({
  getDb,
  syncIndexes,
}: Pick<MigrationContext, "getDb" | "syncIndexes">): Promise<void> => {
  await getDb().execute(`DROP INDEX IF EXISTS ${SLOT_INDEX}`);
  await syncIndexes();
};

/** The slot index's identity columns as the SCHEMA currently declares them —
 * the postcondition every widening migration must land, read from the one
 * declaration so this list can never drift from what `syncIndexes` creates. */
export const slotIndexColumns = (): string[] =>
  SCHEMA.flatMap(([, table]) => table.indexes ?? []).find(
    (index) => index.name === SLOT_INDEX,
  )!.columns;

/** Verify the slot index exists AND its live definition carries every declared
 * identity column. Recreation happens under the index's old name, so a bare
 * existence check cannot tell a landed widening from a stale pre-drop
 * definition that somehow survived (the snapshot-lag class the sync layer
 * documents) — read the live CREATE INDEX sql and demand every column. */
export const verifySlotIndex =
  ({ getDb }: Pick<MigrationContext, "getDb">) =>
  async (): Promise<void> => {
    const result = await getDb().execute({
      args: [SLOT_INDEX],
      sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    });
    const live = result.rows.length > 0 ? String(result.rows[0]!.sql) : "";
    const missing = slotIndexColumns().filter(
      (column) => !live.includes(column),
    );
    if (missing.length > 0) {
      throw new Error(
        `Migration verification failed: index ${SLOT_INDEX} lacks ${missing.join(
          ", ",
        )} (live definition: ${live || "absent"})`,
      );
    }
  };
