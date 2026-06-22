import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MIGRATION_IDS, SCHEMA_HASH } from "#shared/db/migrations.ts";

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
        "2026-06-21_transfers",
      ],
      schemaHash: "14x20pp",
    });
  });
});
