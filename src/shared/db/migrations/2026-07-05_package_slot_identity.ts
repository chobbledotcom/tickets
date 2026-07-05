import {
  recreateSlotIndex,
  SLOT_INDEX_REQUIREMENT,
} from "./booking-slot-index.ts";
import type { Migration, MigrationContext } from "./types.ts";

/**
 * Widen the unique booking-slot index to include package_group_id.
 *
 * One order may now book the same listing through several paths — two
 * overlapping packages, or a package plus the listing's own standalone row —
 * and each path keeps its own `listing_attendees` row (its own price paid and
 * package grouping). The slot index goes from
 * (listing_id, attendee_id, start_at, parent_listing_id) to
 * (…, package_group_id) so those rows never collide. A plain line carries 0,
 * so its slot is unchanged. Same shape as the 2026-06-23 parent_listing_id
 * widening (see {@link recreateSlotIndex}).
 */
export default function packageSlotIdentityMigration(
  ctx: MigrationContext,
): Migration {
  return {
    description:
      "Widen the unique booking-slot index with package_group_id so the same listing booked through two packages (or a package plus standalone) keeps one row per path",
    id: "2026-07-05_package_slot_identity",
    requires: SLOT_INDEX_REQUIREMENT,
    up: () => recreateSlotIndex(ctx),
    verify: ctx.verifyRequirement(SLOT_INDEX_REQUIREMENT),
  };
}
