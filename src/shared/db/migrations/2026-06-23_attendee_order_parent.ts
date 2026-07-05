import { recreateSlotIndex, SLOT_INDEX } from "./booking-slot-index.ts";
import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: {
    listing_attendees: ["order_token", "parent_listing_id"],
  },
  indexes: [SLOT_INDEX],
};

/**
 * Add order_token and parent_listing_id to listing_attendees, and widen the
 * unique slot index to include parent_listing_id.
 *
 * order_token groups every row created in one checkout; parent_listing_id records
 * which parent a folded child was chosen under. The slot index goes from
 * (listing_id, attendee_id, start_at) to (…, parent_listing_id) so the SAME child
 * chosen under two parents books once per parent — two rows that faithfully
 * record their own parent — rather than colliding into one row. A non-child line
 * keeps parent_listing_id 0, so its slot is unchanged.
 *
 * The column and the index that depends on it live in one migration so they are
 * created (and, in the restore test, dropped) together; the drop-then-resync is
 * {@link recreateSlotIndex}.
 */
export default function attendeeOrderParentMigration(
  ctx: MigrationContext,
): Migration {
  return {
    description:
      "Add order_token and parent_listing_id columns to listing_attendees, and widen the unique slot index to include parent_listing_id so a child chosen under two parents books once per parent",
    id: "2026-06-23_attendee_order_parent",
    requires,
    up: async () => {
      await ctx.applySchemaChanges();
      await recreateSlotIndex(ctx);
    },
    verify: ctx.verifyRequirement(requires),
  };
}
