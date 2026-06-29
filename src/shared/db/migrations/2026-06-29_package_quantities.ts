import { schemaMigration } from "./define.ts";

/**
 * Add the two columns that make a package a true bundle:
 *  - `group_listings.quantity` — how many of this listing one unit of the
 *    package includes (≥1; default 1). The buyer picks a single package
 *    quantity and each member's booked quantity is `quantity × package_qty`.
 *  - `groups.hide_package_listings` — when set, the package's member listings
 *    are hidden from buyers, tickets, and confirmation emails (admins still see
 *    them).
 *
 * Both have safe defaults, so `applySchemaChanges` adds them from SCHEMA with no
 * backfill: existing memberships get quantity 1 and packages stay un-hidden.
 */
export default schemaMigration(
  "2026-06-29_package_quantities",
  "Add group_listings.quantity and groups.hide_package_listings.",
  {
    columns: {
      group_listings: ["quantity"],
      groups: ["hide_package_listings"],
    },
  },
);
