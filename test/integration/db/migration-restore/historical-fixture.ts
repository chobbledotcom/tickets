import { expect } from "@std/expect";
import { getDb } from "#shared/db/client.ts";
import { createLegacyPaymentTables } from "#test-utils/legacy-payment-tables.ts";

export interface HistoricalFixtureExpectations {
  attendeeActivity: boolean;
  legacyPaymentReference: boolean;
  legacyPayments: boolean;
  modifierAggregates: boolean;
}

const scalar = async (sql: string): Promise<unknown> => {
  const result = await getDb().execute(sql);
  return result.rows[0]?.value;
};

export const seedHistoricalFixture = async (
  legacyPayments: boolean,
): Promise<void> => {
  if (legacyPayments) await createLegacyPaymentTables(getDb);
  await getDb().batch(
    [
      `INSERT INTO groups (id, slug, slug_index, name, description, max_attendees)
       VALUES (901, 'migration-group', 'group-index', 'Migration Group', 'historic group', 50)`,
      `INSERT INTO listings (id, created, max_attendees, name, slug, slug_index, unit_price, max_quantity, listing_type, date, location, customisable_days, uses_logistics)
       VALUES (902, '2024-01-01T00:00:00Z', 25, 'migration-listing', 'migration-listing', 'listing-index', 1200, 4, 'standard', '2024-02-01', 'Town Hall', 1, 1)`,
      `INSERT INTO attendees (id, created, checked_in, ticket_token_index, pii_blob, status_id, split_logistics_agents, phone_index)
       VALUES (903, '2024-01-02T00:00:00Z', '', 'ticket-index', '{"name":"Migration Guest"}', 1, 1, 'phone-index')`,
      `INSERT INTO listing_attendees (id, listing_id, attendee_id, start_at, end_at, quantity, checked_in, start_agent_id, end_agent_id, start_time, end_time, start_done, end_done)
       VALUES (904, 902, 903, '2024-02-01T10:00:00Z', '2024-02-01T12:00:00Z', 2, 1, NULL, NULL, '10:00', '12:00', 1, 0)`,
      ...(legacyPayments
        ? [
            `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data, payment_reference)
             VALUES ('payment-session', 903, '2024-01-02T00:10:00Z', 'enc:1:fixture-ticket-token', '', 'hyb:1:fixture-reference')`,
          ]
        : []),
      `INSERT INTO activity_log (id, created, listing_id, message, attendee_id)
       VALUES (905, '2024-01-02T00:15:00Z', 902, 'fixture activity', 903)`,
      ...(legacyPayments
        ? [
            `INSERT INTO sumup_checkouts (reference_index, wrapped_key, metadata, sumup_id, created_at)
             VALUES ('sumup-reference', 'wk:1:fixture-key', 'enc:1:fixture-metadata', 'sumup-id', '2024-01-02T00:20:00Z')`,
          ]
        : []),
      `INSERT INTO questions (id, text, sort_order, display_type, assign_all)
       VALUES (906, 'Meal choice?', 7, 'select', 1)`,
      `INSERT INTO modifiers (id, name, calc_kind, calc_value, direction, active, trigger, code, code_index, scope, stock, max_per_order, min_subtotal, min_visits)
       VALUES (907, 'VIP uplift', 'fixed', 5, 'increase', 1, 'answer', '', NULL, 'listing', 20, 2, 1000, 1)`,
      `INSERT INTO answers (id, question_id, text, sort_order, modifier_id)
       VALUES (908, 906, 'Vegetarian', 3, 907)`,
      `INSERT INTO listing_questions (id, listing_id, question_id, sort_order)
       VALUES (909, 902, 906, 4)`,
      `INSERT INTO attendee_answers (id, attendee_id, answer_id, question_id)
       VALUES (910, 903, 908, 906)`,
      `INSERT INTO modifier_listings (modifier_id, listing_id)
       VALUES (907, 902)`,
      `INSERT INTO modifier_groups (modifier_id, group_id)
       VALUES (907, 901)`,
      `INSERT INTO modifier_usages (id, modifier_id, attendee_id, quantity, amount_applied, created)
       VALUES (911, 907, 903, 2, 500, '2024-01-02T00:25:00Z')`,
      `INSERT INTO holidays (id, name, start_date, end_date)
       VALUES (912, 'Fixture holiday', '2024-03-01', '2024-03-03')`,
      `INSERT INTO built_sites (id, site_data, assignable, assigned_attendee_id, assigned_listing_id, created, renewal_token_index, read_only_from)
       VALUES (913, '{"site":"fixture"}', 1, 903, 902, '2024-01-03T00:00:00Z', 'renewal-index', '')`,
      `INSERT INTO email_templates (id, subject, body)
       VALUES (914, 'Fixture subject', 'Fixture body')`,
      `INSERT INTO sms_messages (id, attendee_id, listing_id, provider_id, created)
       VALUES (915, 903, 902, 'provider-message', '2024-01-03T00:05:00Z')`,
      `INSERT INTO processed_sms_inbound (webhook_id, created)
       VALUES ('sms-webhook', '2024-01-03T00:06:00Z')`,
      `INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity)
       VALUES ('contact-hash', 1, 5, '{}', 1700000000)`,
    ],
    "write",
  );
};

const assertPaymentMigration = async (
  hasPaymentReference: boolean,
): Promise<void> => {
  const [sessions, charges, cases] = await getDb().batch(
    [
      `SELECT attendee_id, state, result_state, ticket_state, completion_state
         FROM payment_sessions WHERE origin = 'legacy' ORDER BY created_at`,
      `SELECT provider_reference, legacy_source, refund_state
         FROM payment_charges WHERE origin = 'legacy'`,
      "SELECT reason, state FROM payment_cases ORDER BY reason",
    ],
    "read",
  );
  expect(sessions!.rows).toEqual([
    {
      attendee_id: 903,
      completion_state: "legacy_unknown",
      result_state: "succeeded",
      state: "completed",
      ticket_state: "ready",
    },
    {
      attendee_id: null,
      completion_state: "none",
      result_state: "none",
      state: "pending",
      ticket_state: "none",
    },
  ]);
  expect(charges!.rows).toEqual(
    hasPaymentReference
      ? [
          {
            legacy_source: "processed_payments",
            provider_reference: "hyb:1:fixture-reference",
            refund_state: "unknown",
          },
        ]
      : [],
  );
  expect(cases!.rows).toEqual([
    { reason: "legacy_provider_session", state: "resolved" },
    ...(hasPaymentReference
      ? [{ reason: "legacy_provider_unknown", state: "needs_action" }]
      : []),
  ]);
};

const assertLegacySourcesRetired = async (): Promise<void> => {
  const result = await getDb().execute(
    `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('processed_payments', 'checkout_stages', 'sumup_checkouts')`,
  );
  expect(result.rows).toEqual([]);
};

export const assertHistoricalFixtureSurvived = async (
  expected: HistoricalFixtureExpectations,
): Promise<void> => {
  const checks = [
    "SELECT COUNT(*) AS value FROM listings WHERE id = 902 AND name = 'migration-listing' AND booked_quantity = 2 AND tickets_count = 1",
    "SELECT COUNT(*) AS value FROM listing_attendees WHERE id = 904 AND listing_id = 902 AND attendee_id = 903 AND quantity = 2",
    "SELECT COUNT(*) AS value FROM attendees WHERE id = 903 AND ticket_token_index = 'ticket-index'",
    "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND listing_id = 902 AND message = 'fixture activity'",
    "SELECT COUNT(*) AS value FROM groups WHERE id = 901 AND slug_index = 'group-index'",
    "SELECT COUNT(*) AS value FROM built_sites WHERE id = 913 AND assigned_listing_id = 902 AND assigned_attendee_id = 903",
    "SELECT COUNT(*) AS value FROM questions WHERE id = 906 AND text = 'Meal choice?'",
    "SELECT COUNT(*) AS value FROM answers WHERE id = 908 AND question_id = 906 AND times_selected = 1",
    "SELECT COUNT(*) AS value FROM attendee_answers WHERE id = 910 AND attendee_id = 903 AND answer_id = 908",
  ];
  for (const sql of checks) expect(await scalar(sql)).toBe(1);
  if (expected.attendeeActivity) {
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND attendee_id = 903",
      ),
    ).toBe(1);
  }
  if (expected.modifierAggregates) {
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM modifiers WHERE id = 907 AND total_uses = 2 AND usage_count = 1",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM modifier_usages WHERE id = 911 AND modifier_id = 907 AND attendee_id = 903",
      ),
    ).toBe(1);
  }
  if (expected.legacyPayments) {
    await assertPaymentMigration(expected.legacyPaymentReference);
  }
  await assertLegacySourcesRetired();
};
