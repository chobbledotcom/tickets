/**
 * Ordered registry of every dated migration: its id plus a loader for the
 * module that builds it.
 *
 * The boot path reads only the ids here (plus the schema markers), so the
 * migration implementations — and everything they import — stay out of the
 * cold-start module graph and load lazily on the rare request that actually
 * has migration work to do. Keep this list in the exact order migrations must
 * run; it IS the run order (the old MIGRATIONS array order, comments and all).
 *
 * Each entry's id doubles as the module's filename, and
 * `test/shared/db/migration-registry.test.ts` loads every entry to assert the
 * built migration carries the same id, so the two cannot drift.
 */
import type { MigrationBuilder } from "./types.ts";

export type MigrationRegistryEntry = {
  id: string;
  /** Load the module whose default export builds this migration. */
  load: () => Promise<{ default: MigrationBuilder }>;
};

const entry = (
  id: string,
  load: () => Promise<{ default: MigrationBuilder }>,
): MigrationRegistryEntry => ({ id, load });

/* jscpd:ignore-start -- one loader line per migration module, import-block-like by nature */
export const MIGRATION_REGISTRY: MigrationRegistryEntry[] = [
  entry(
    "2026-06-11_current_schema",
    () => import("./2026-06-11_current_schema.ts"),
  ),
  entry(
    "2026-06-12_sumup_checkouts",
    () => import("./2026-06-12_sumup_checkouts.ts"),
  ),
  entry(
    "2026-06-13_event_attendees_overlap_index",
    () => import("./2026-06-13_event_attendees_overlap_index.ts"),
  ),
  entry(
    "2026-06-14_rename_events_to_listings",
    () => import("./2026-06-14_rename_events_to_listings.ts"),
  ),
  entry(
    "2026-06-14_question_sort_order",
    () => import("./2026-06-14_question_sort_order.ts"),
  ),
  entry(
    "2026-06-14_email_preferences",
    () => import("./2026-06-14_email_preferences.ts"),
  ),
  entry(
    "2026-06-14_listing_customisable_days",
    () => import("./2026-06-14_listing_customisable_days.ts"),
  ),
  entry(
    "2026-06-14_attendee_statuses",
    () => import("./2026-06-14_attendee_statuses.ts"),
  ),
  entry(
    "2026-06-15_activity_log_listing_id_index",
    () => import("./2026-06-15_activity_log_listing_id_index.ts"),
  ),
  entry(
    "2026-06-16_logistics_agents",
    () => import("./2026-06-16_logistics_agents.ts"),
  ),
  entry(
    "2026-06-16_email_templates",
    () => import("./2026-06-16_email_templates.ts"),
  ),
  entry("2026-06-16_agent_users", () => import("./2026-06-16_agent_users.ts")),
  entry(
    "2026-06-16_processed_payments_failure_data",
    () => import("./2026-06-16_processed_payments_failure_data.ts"),
  ),
  entry(
    "2026-06-16_listing_aggregates",
    () => import("./2026-06-16_listing_aggregates.ts"),
  ),
  entry("2026-06-16_modifiers", () => import("./2026-06-16_modifiers.ts")),
  entry(
    "2026-06-17_modifier_code",
    () => import("./2026-06-17_modifier_code.ts"),
  ),
  entry(
    "2026-06-16_sms_messages",
    () => import("./2026-06-16_sms_messages.ts"),
  ),
  entry(
    "2026-06-17_processed_sms_inbound",
    () => import("./2026-06-17_processed_sms_inbound.ts"),
  ),
  entry(
    "2026-06-16_attendee_phone_index",
    () => import("./2026-06-16_attendee_phone_index.ts"),
  ),
  entry(
    "2026-06-17_modifier_aggregates",
    () => import("./2026-06-17_modifier_aggregates.ts"),
  ),
  entry(
    "2026-06-18_contact_preferences",
    () => import("./2026-06-18_contact_preferences.ts"),
  ),
  entry(
    "2026-06-18_modifier_min_visits",
    () => import("./2026-06-18_modifier_min_visits.ts"),
  ),
  entry(
    "2026-06-18_question_display_type",
    () => import("./2026-06-18_question_display_type.ts"),
  ),
  entry(
    "2026-06-18_answer_modifiers",
    () => import("./2026-06-18_answer_modifiers.ts"),
  ),
  entry(
    "2026-06-18_question_assign_all",
    () => import("./2026-06-18_question_assign_all.ts"),
  ),
  entry(
    "2026-06-19_answer_aggregates",
    () => import("./2026-06-19_answer_aggregates.ts"),
  ),
  entry(
    "2026-06-19_built_sites_last_pruned",
    () => import("./2026-06-19_built_sites_last_pruned.ts"),
  ),
  entry(
    "2026-06-20_free_text_questions",
    () => import("./2026-06-20_free_text_questions.ts"),
  ),
  entry(
    "2026-06-20_string_created",
    () => import("./2026-06-20_string_created.ts"),
  ),
  entry(
    "2026-06-20_answer_active",
    () => import("./2026-06-20_answer_active.ts"),
  ),
  entry(
    "2026-06-20_contact_booking_counts",
    () => import("./2026-06-20_contact_booking_counts.ts"),
  ),
  entry("2026-06-20_user_kek_v2", () => import("./2026-06-20_user_kek_v2.ts")),
  entry(
    "2026-06-21_listing_parents",
    () => import("./2026-06-21_listing_parents.ts"),
  ),
  entry("2026-06-21_transfers", () => import("./2026-06-21_transfers.ts")),
  entry(
    "2026-06-22_transfers_time_int",
    () => import("./2026-06-22_transfers_time_int.ts"),
  ),
  // Adds order_token + parent_listing_id to listing_attendees. Ordered BEFORE the
  // ledger migrations that REBUILD listing_attendees, so those rebuilds (which
  // copy from the current SCHEMA — already carrying these columns) find them.
  entry(
    "2026-06-23_attendee_order_parent",
    () => import("./2026-06-23_attendee_order_parent.ts"),
  ),
  entry(
    "2026-06-22_drop_transfers_currency",
    () => import("./2026-06-22_drop_transfers_currency.ts"),
  ),
  entry(
    "2026-06-22_listing_attendee_ledger_event_group",
    () => import("./2026-06-22_listing_attendee_ledger_event_group.ts"),
  ),
  entry(
    "2026-06-22_backfill_transfers",
    () => import("./2026-06-22_backfill_transfers.ts"),
  ),
  entry(
    "2026-06-22_drop_listing_income",
    () => import("./2026-06-22_drop_listing_income.ts"),
  ),
  entry(
    "2026-06-22_drop_listing_attendee_refunded",
    () => import("./2026-06-22_drop_listing_attendee_refunded.ts"),
  ),
  entry(
    "2026-06-22_drop_listing_attendee_price_paid",
    () => import("./2026-06-22_drop_listing_attendee_price_paid.ts"),
  ),
  entry(
    "2026-06-22_drop_attendees_price_paid",
    () => import("./2026-06-22_drop_attendees_price_paid.ts"),
  ),
  entry(
    "2026-06-22_drop_attendees_remaining_balance",
    () => import("./2026-06-22_drop_attendees_remaining_balance.ts"),
  ),
  entry(
    "2026-06-22_drop_modifiers_total_revenue",
    () => import("./2026-06-22_drop_modifiers_total_revenue.ts"),
  ),
  entry(
    "2026-06-23_system_notes",
    () => import("./2026-06-23_system_notes.ts"),
  ),
  // Runs after drop_listing_income so the trigger rebuild lands on top of the
  // income-free bodies: re-counts tickets_count as quantity > 0 only.
  entry(
    "2026-06-23_ticket_count_no_quantity",
    () => import("./2026-06-23_ticket_count_no_quantity.ts"),
  ),
  entry(
    "2026-06-24_built_sites_updates",
    () => import("./2026-06-24_built_sites_updates.ts"),
  ),
  entry(
    "2026-06-24_attendees_kind",
    () => import("./2026-06-24_attendees_kind.ts"),
  ),
  // Pure index add (idempotent CREATE INDEX IF NOT EXISTS via syncIndexes);
  // order-independent, appended last.
  entry(
    "2026-06-25_listing_attendee_ledger_event_group_index",
    () => import("./2026-06-25_listing_attendee_ledger_event_group_index.ts"),
  ),
  entry(
    "2026-06-26_attendees_kind_not_null",
    () => import("./2026-06-26_attendees_kind_not_null.ts"),
  ),
  entry(
    "2026-06-27_service_costs",
    () => import("./2026-06-27_service_costs.ts"),
  ),
  // Pure additive column add (use_defaults on listings); from main.
  entry(
    "2026-06-28_listing_use_defaults",
    () => import("./2026-06-28_listing_use_defaults.ts"),
  ),
  entry(
    "2026-06-28_group_listings",
    () => import("./2026-06-28_group_listings.ts"),
  ),
  entry(
    "2026-06-29_package_quantities",
    () => import("./2026-06-29_package_quantities.ts"),
  ),
  // Stamps package_group_id on each booking row of a package order, so tickets
  // and emails group by the persisted id rather than membership equality.
  entry(
    "2026-06-29_attendee_package_group",
    () => import("./2026-06-29_attendee_package_group.ts"),
  ),
  // From main: two new tables for user-created content pages (additive).
  entry("2026-07-01_site_pages", () => import("./2026-07-01_site_pages.ts")),
  // From main: listing_prices table + backfill from unit_price/day_prices.
  entry(
    "2026-07-01_listing_prices",
    () => import("./2026-07-01_listing_prices.ts"),
  ),
  // From main: pure additive column add (bookable_alone on listings).
  entry(
    "2026-07-02_bookable_alone",
    () => import("./2026-07-02_bookable_alone.ts"),
  ),
  // Move the flat package override off group_listings into listing_prices'
  // "group" dimension and drop the column — package pricing now lives entirely
  // in listing_prices.
  entry(
    "2026-07-02_group_flat_prices",
    () => import("./2026-07-02_group_flat_prices.ts"),
  ),
  // Move per-day-count prices off listings.day_prices into listing_prices'
  // "day_count" dimension and drop the column — only unit_price stays a column.
  entry(
    "2026-07-02_drop_listings_day_prices",
    () => import("./2026-07-02_drop_listings_day_prices.ts"),
  ),
  // Data-only: rewrite {{listing}} → {{listings}} in the stored attendee
  // column-order template, matching the renamed grouped Listings column.
  entry(
    "2026-07-03_attendee_listings_tag",
    () => import("./2026-07-03_attendee_listings_tag.ts"),
  ),
  // Historical no-op: image thumbnails now live on first-class image records.
  entry(
    "2026-07-03_listing_image_thumb",
    () => import("./2026-07-03_listing_image_thumb.ts"),
  ),
  // Widen the unique booking-slot index with package_group_id so overlapping
  // package paths keep one row each.
  entry(
    "2026-07-05_package_slot_identity",
    () => import("./2026-07-05_package_slot_identity.ts"),
  ),
  // Create reusable image records plus ordered item uses.
  entry(
    "2026-07-05_first_class_images",
    () => import("./2026-07-05_first_class_images.ts"),
  ),
  // Create the encrypted address-lookup result cache.
  entry(
    "2026-07-05_address_cache",
    () => import("./2026-07-05_address_cache.ts"),
  ),
  // Create news posts for the public news system.
  entry("2026-07-06_news_posts", () => import("./2026-07-06_news_posts.ts")),
  // Add the cross-listing (end_at, start_at) index behind the Logistics
  // tab's Other Attendees overlap query.
  entry(
    "2026-07-06_listing_attendees_end_start_index",
    () => import("./2026-07-06_listing_attendees_end_start_index.ts"),
  ),
  // Store every provider charge reference for later full-account refunds.
  entry(
    "2026-07-07_processed_payments_payment_reference",
    () => import("./2026-07-07_processed_payments_payment_reference.ts"),
  ),
  // Add the encrypted per-contact list of booked ticket tokens.
  entry(
    "2026-07-07_contact_attendee_tokens",
    () => import("./2026-07-07_contact_attendee_tokens.ts"),
  ),
  // Public listing attributes and their multiple-choice options.
  entry(
    "2026-07-09_listing_attributes",
    () => import("./2026-07-09_listing_attributes.ts"),
  ),
  // Index processed_payments by attendee for roster/export/refund lookups.
  entry(
    "2026-07-10_processed_payments_attendee_index",
    () => import("./2026-07-10_processed_payments_attendee_index.ts"),
  ),
  // Data-only repair: delete image records whose filename decrypts to "" —
  // legacy encrypted-empty listing image_urls the first-class images backfill
  // mistook for real filenames.
  entry(
    "2026-07-12_remove_broken_image_records",
    () => import("./2026-07-12_remove_broken_image_records.ts"),
  ),
  // Replace the old logistics switch with one plain feature-visibility map,
  // enabling entries that already have saved records.
  entry(
    "2026-07-15_enabled_features",
    () => import("./2026-07-15_enabled_features.ts"),
  ),
  // Keep every attendee status reference tied to a live status row.
  entry(
    "2026-07-15_attendee_status_integrity",
    () => import("./2026-07-15_attendee_status_integrity.ts"),
  ),
  // Add dormant checkout stage storage and its revision counter.
  entry(
    "2026-07-15_checkout_stages",
    () => import("./2026-07-15_checkout_stages.ts"),
  ),
  // Bind payment reservations to dormant checkout stages before stage runtime
  // is activated in a later change.
  entry(
    "2026-07-16_checkout_stage_payment_fences",
    () => import("./2026-07-16_checkout_stage_payment_fences.ts"),
  ),
];
/* jscpd:ignore-end */

/** Every migration id, in run order. */
export const MIGRATION_IDS: string[] = MIGRATION_REGISTRY.map(
  (migration) => migration.id,
);
