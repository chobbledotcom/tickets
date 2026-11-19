// effects: pure
/**
 * The columns that hold the `id` of a row in another table. A read joins two
 * tables along one of these columns. The name of the join is the name of the
 * column without `_id`.
 *
 * The types refuse a table or a column that the schema does not declare. A
 * test joins along each reference in a real database.
 */

import type { RowOf, TableName } from "#db/select/tables.ts";

type IdColumnOf<Name extends TableName> = keyof RowOf<Name> & `${string}_id`;

/** For each table, the table that each of its referring columns points at. */
type References = {
  readonly [Name in TableName]?: {
    readonly [Column in IdColumnOf<Name>]?: TableName;
  };
};

/* jscpd:ignore-start -- a list of strings, not code */
export const REFERENCES = {
  activity_log: { attendee_id: "attendees", listing_id: "listings" },
  answers: { modifier_id: "modifiers", question_id: "questions" },
  answers_at_booking: {
    answer_id: "answers",
    attendee_id: "attendees",
    question_id: "questions",
  },
  api_keys: { user_id: "users" },
  attendee_answers: {
    answer_id: "answers",
    attendee_id: "attendees",
    question_id: "questions",
    string_id: "strings",
  },
  attendees: { status_id: "attendee_statuses" },
  attribute_options: { attribute_id: "attributes" },
  booking_tax_assessments: { attendee_id: "attendees" },
  built_sites: {
    assigned_attendee_id: "attendees",
    assigned_listing_id: "listings",
  },
  checkout_stages: { attendee_id: "attendees" },
  external_source_links: { source_id: "external_sources" },
  group_listings: { group_id: "groups", listing_id: "listings" },
  image_uses: { image_id: "images" },
  invoices: { attendee_id: "attendees" },
  listing_attendees: {
    attendee_id: "attendees",
    end_agent_id: "logistics_agents",
    listing_id: "listings",
    package_group_id: "groups",
    parent_listing_id: "listings",
    start_agent_id: "logistics_agents",
  },
  listing_attribute_options: {
    listing_id: "listings",
    option_id: "attribute_options",
  },
  listing_parents: {
    child_listing_id: "listings",
    parent_listing_id: "listings",
  },
  listing_prices: { listing_id: "listings" },
  listing_questions: { listing_id: "listings", question_id: "questions" },
  modifier_groups: { group_id: "groups", modifier_id: "modifiers" },
  modifier_listings: { listing_id: "listings", modifier_id: "modifiers" },
  modifier_usages: { attendee_id: "attendees", modifier_id: "modifiers" },
  payment_case_decisions: { case_id: "payment_cases" },
  payment_cases: { payment_id: "payment_sessions" },
  payment_completion_deliveries: { payment_id: "payment_sessions" },
  payment_completion_effects: { payment_id: "payment_sessions" },
  payment_sessions: { attendee_id: "attendees" },
  processed_payments: { attendee_id: "attendees" },
  refund_confirmations: { attendee_id: "attendees" },
  service_costs: {
    listing_id: "listings",
    servicing_attendee_id: "attendees",
    transfer_id: "transfers",
  },
  sessions: { user_id: "users" },
  site_page_items: { page_id: "site_pages" },
  sms_messages: { attendee_id: "attendees", listing_id: "listings" },
  transfers: { reverses_id: "transfers" },
  user_logistics_agents: { agent_id: "logistics_agents", user_id: "users" },
} as const satisfies References;
/* jscpd:ignore-end */
