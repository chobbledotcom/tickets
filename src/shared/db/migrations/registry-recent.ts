/** The migrations of 2026-08 onward, in run order. Part two of the registry
 * (see registry.ts). */
import { entry, type MigrationRegistryEntry } from "./registry-load.ts";

/* jscpd:ignore-start -- one loader line per migration module, import-block-like by nature */
export const ENTRIES_RECENT: MigrationRegistryEntry[] = [
  entry(
    "2026-08-04_login_attempt_stamp",
    () => import("./2026-08-04_login_attempt_stamp.ts"),
  ),
  // Everything the durable refund authority needs, in one migration. It drops
  // the dormant payment-record tables before the declarative apply reaches
  // them: this release redefines those tables, and the apply can only ADD
  // COLUMN to a table that already exists — which SQLite refuses for the new
  // PRIMARY KEY. Splitting this work apart is what let an upgrade break, so
  // keep the drop and the apply in the same migration.
  entry(
    "2026-08-10_refund_authority_records",
    () => import("./2026-08-10_refund_authority_records.ts"),
  ),
  entry(
    "2026-08-18_sumup_recovery_state",
    () => import("./2026-08-18_sumup_recovery_state.ts"),
  ),
  // The per-order join the refunded projection reads: names the booking order
  // each refund leg reverses, backfilled over every stored refund leg.
  entry(
    "2026-09-11_refund_order_link",
    () => import("./2026-09-11_refund_order_link.ts"),
  ),
  entry(
    "2026-09-14_group_show_hidden_listings",
    () => import("./2026-09-14_group_show_hidden_listings.ts"),
  ),
  // The group scanner's door preference: one listing per scan, or every
  // listing at once when the group's checkbox says so.
  entry(
    "2026-09-15_group_scan_checks_in_all_listings",
    () => import("./2026-09-15_group_scan_checks_in_all_listings.ts"),
  ),
  entry(
    "2026-09-28_answers_at_booking",
    () => import("./2026-09-28_answers_at_booking.ts"),
  ),
  entry(
    "2026-09-29_checkout_pending_answers",
    () => import("./2026-09-29_checkout_pending_answers.ts"),
  ),
  // checked_in flips from a 0/1 flag to a count of admitted tickets.
  entry(
    "2026-09-30_checked_in_count",
    () => import("./2026-09-30_checked_in_count.ts"),
  ),
  // One sealed cancel handle per unpaid Square checkout, so the expiry task
  // can end the link at the checkout window.
  entry(
    "2026-10-01_square_link_ends",
    () => import("./2026-10-01_square_link_ends.ts"),
  ),
  // The per-purchase quantity floor, defaulting every existing listing to 1.
  entry(
    "2026-10-05_listing_min_quantity",
    () => import("./2026-10-05_listing_min_quantity.ts"),
  ),
  // Repair the holiday dates the pre-2476 mapper stored unpadded.
  entry(
    "2026-10-07_holiday_date_padding",
    () => import("./2026-10-07_holiday_date_padding.ts"),
  ),
];
/* jscpd:ignore-end */
