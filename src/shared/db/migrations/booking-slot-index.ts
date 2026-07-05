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
