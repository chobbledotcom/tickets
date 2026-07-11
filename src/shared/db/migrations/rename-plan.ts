import type { LegacyRenamePlan } from "./rename-utils.ts";

/**
 * The table and column renames that turned the legacy "event" domain into
 * "listing". Lives in its own small module (not in the dated rename migration)
 * because the always-loaded migration machinery needs it for the baseline
 * reconcile, while the dated migration modules load lazily.
 */
export const EVENT_TO_LISTING_RENAME_PLAN: LegacyRenamePlan = {
  columnRenames: [
    ["listings", "event_type", "listing_type"],
    ["listing_attendees", "event_id", "listing_id"],
    ["listing_questions", "event_id", "listing_id"],
    ["activity_log", "event_id", "listing_id"],
    ["built_sites", "assigned_event_id", "assigned_listing_id"],
  ],
  tableRenames: [
    ["events", "listings"],
    ["event_attendees", "listing_attendees"],
    ["event_questions", "listing_questions"],
  ],
};
