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
  // them. This release redefines those tables, and the apply can only ADD
  // COLUMN to a table that already exists. The apply cannot drop the columns
  // the redefinition removed. SQLite refuses the NOT NULL columns it adds to
  // a table that holds rows. Splitting this work apart is what let an
  // upgrade break, so keep the drop and the apply in the same migration.
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
  // The saved flag the CSP builder reads, backfilled by scanning the stored
  // stylesheet once.
  entry(
    "2026-10-11_custom_css_bunny_fonts",
    () => import("./2026-10-11_custom_css_bunny_fonts.ts"),
  ),
  // The per-booking flags that mark an owed confirmation email or webhook
  // send, so a failed send is visible instead of silent.
  entry(
    "2026-10-12_pending_notification_flags",
    () => import("./2026-10-12_pending_notification_flags.ts"),
  ),
  // The listing contact fields in the one stored form, so the badge SQL can
  // compare whole tokens the way the parser reads them.
  entry(
    "2026-10-12_listing_fields_trim",
    () => import("./2026-10-12_listing_fields_trim.ts"),
  ),
  // The page editor's Hidden flag: one stored page drops out of the public
  // menus and the sitemap and answers with a noindex robots tag.
  entry(
    "2026-10-19_site_page_hidden",
    () => import("./2026-10-19_site_page_hidden.ts"),
  ),
  // The door's replay ledger for queued offline check-in deliveries.
  entry(
    "2026-10-20_processed_scan_operations",
    () => import("./2026-10-20_processed_scan_operations.ts"),
  ),
  // The partial index the dashboard count seeks, so the count reads the few
  // flagged attendees instead of every attendee row.
  entry(
    "2026-10-26_attendees_pending_flags_index",
    () => import("./2026-10-26_attendees_pending_flags_index.ts"),
  ),
];
/* jscpd:ignore-end */
