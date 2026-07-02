import { schemaMigration } from "./define.ts";

/**
 * Add `listing_attendees.package_group_id` — the id of the package group an
 * order belongs to (0 = not a package), stamped on every booking row of one
 * package checkout the way `order_token` / `parent_listing_id` are.
 *
 * The ticket view and confirmation email group a booking's lines under the
 * package name by this PERSISTED id, so a standalone order of the same listings
 * (e.g. `/ticket/a+b`, or a one-member package's listing booked via its normal
 * page) is no longer mistaken for the package by membership-equality.
 *
 * It has a safe default, so `applySchemaChanges` adds it from SCHEMA with no
 * backfill: existing rows get 0 (not a package).
 */
export default schemaMigration(
  "2026-06-29_attendee_package_group",
  "Add listing_attendees.package_group_id (the package group an order belongs to; 0 = not a package).",
  {
    columns: {
      listing_attendees: ["package_group_id"],
    },
  },
);
