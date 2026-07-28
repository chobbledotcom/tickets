import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  LATEST_UPDATE,
  MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#shared/db/migrations/schema/version.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";

describe("db > migrations > schema change guard", () => {
  // If this test fails, SCHEMA was changed. Existing production databases
  // are only upgraded through named migrations: add a new migration file
  // for the change, register it in migrations.ts, then update BOTH snapshots
  // below together.
  test("SCHEMA_HASH changes only alongside a new named migration", () => {
    expect({ migrationIds: MIGRATION_IDS, schemaHash: SCHEMA_HASH }).toEqual({
      migrationIds: [
        "2026-06-11_current_schema",
        "2026-06-12_sumup_checkouts",
        "2026-06-13_event_attendees_overlap_index",
        "2026-06-14_rename_events_to_listings",
        "2026-06-14_question_sort_order",
        "2026-06-14_email_preferences",
        "2026-06-14_listing_customisable_days",
        "2026-06-14_attendee_statuses",
        "2026-06-15_activity_log_listing_id_index",
        "2026-06-16_logistics_agents",
        "2026-06-16_email_templates",
        "2026-06-16_agent_users",
        "2026-06-16_processed_payments_failure_data",
        "2026-06-16_listing_aggregates",
        "2026-06-16_modifiers",
        "2026-06-17_modifier_code",
        "2026-06-16_sms_messages",
        "2026-06-17_processed_sms_inbound",
        "2026-06-16_attendee_phone_index",
        "2026-06-17_modifier_aggregates",
        "2026-06-18_contact_preferences",
        "2026-06-18_modifier_min_visits",
        "2026-06-18_question_display_type",
        "2026-06-18_answer_modifiers",
        "2026-06-18_question_assign_all",
        "2026-06-19_answer_aggregates",
        "2026-06-19_built_sites_last_pruned",
        "2026-06-20_free_text_questions",
        "2026-06-20_string_created",
        "2026-06-20_answer_active",
        "2026-06-20_contact_booking_counts",
        "2026-06-20_user_kek_v2",
        "2026-06-21_listing_parents",
        "2026-06-21_transfers",
        "2026-06-22_transfers_time_int",
        "2026-06-23_attendee_order_parent",
        "2026-06-22_drop_transfers_currency",
        "2026-06-22_listing_attendee_ledger_event_group",
        "2026-06-22_backfill_transfers",
        "2026-06-22_drop_listing_income",
        "2026-06-22_drop_listing_attendee_refunded",
        "2026-06-22_drop_listing_attendee_price_paid",
        "2026-06-22_drop_attendees_price_paid",
        "2026-06-22_drop_attendees_remaining_balance",
        "2026-06-22_drop_modifiers_total_revenue",
        "2026-06-23_system_notes",
        "2026-06-23_ticket_count_no_quantity",
        "2026-06-24_built_sites_updates",
        "2026-06-24_attendees_kind",
        "2026-06-25_listing_attendee_ledger_event_group_index",
        "2026-06-26_attendees_kind_not_null",
        "2026-06-27_service_costs",
        "2026-06-28_listing_use_defaults",
        "2026-06-28_group_listings",
        "2026-06-29_package_quantities",
        "2026-06-29_attendee_package_group",
        "2026-07-01_site_pages",
        "2026-07-01_listing_prices",
        "2026-07-02_bookable_alone",
        "2026-07-02_group_flat_prices",
        "2026-07-02_drop_listings_day_prices",
        "2026-07-03_attendee_listings_tag",
        "2026-07-03_listing_image_thumb",
        "2026-07-05_package_slot_identity",
        "2026-07-05_first_class_images",
        "2026-07-05_address_cache",
        "2026-07-06_news_posts",
        "2026-07-06_listing_attendees_end_start_index",
        "2026-07-07_processed_payments_payment_reference",
        "2026-07-07_contact_attendee_tokens",
        "2026-07-09_listing_attributes",
        "2026-07-10_processed_payments_attendee_index",
        "2026-07-12_remove_broken_image_records",
        "2026-07-15_enabled_features",
        "2026-07-15_attendee_status_integrity",
        "2026-07-15_checkout_stages",
        "2026-07-16_drop_checkout_stage_revisions",
        "2026-07-18_maintenance_tasks",
        "2026-07-18_drop_built_sites_last_pruned",
        "2026-07-19_maintenance_checkpoint",
        "2026-07-21_activity_backfill_complete",
        "2026-07-22_maintenance_completion",
        "2026-07-26_payment_records",
      ],
      schemaHash: "6nu8lh",
    });
  });

  test("names the current update and schema metadata exactly", () => {
    expect({
      dbSchemaHash: DB_SCHEMA_HASH_KEY,
      latestDbUpdate: LATEST_DB_UPDATE_KEY,
      latestUpdate: LATEST_UPDATE,
      migrationLock: MIGRATION_LOCK_KEY,
      schemaMigrations: SCHEMA_MIGRATIONS_TABLE,
    }).toEqual({
      dbSchemaHash: "db_schema_hash",
      latestDbUpdate: "latest_db_update",
      latestUpdate: "Add the tables one payment record lives in.",
      migrationLock: "migration_lock",
      schemaMigrations: "schema_migrations",
    });
  });
});
