// effects: pure
/**
 * Every table as a read sees it. Each table has the type of its stored row,
 * the columns that refer to another table, and the word a query calls it by.
 *
 * All of it comes from the schema declaration. A column that the schema does
 * not declare is a compile error in a read.
 */

import { TYPED_SCHEMA } from "#db/migrations/schema/index.ts";
import { columnFacts } from "#db/migrations/schema/scalar-columns.ts";
import type {
  Column,
  ColumnKind,
  RefersTo,
} from "#db/migrations/schema/types.ts";
import { requiredMapValue } from "#fp";

type Declared = (typeof TYPED_SCHEMA)[number];

/** The name of a declared table. */
export type TableName = Declared[0];

type ColumnOf<Name extends TableName> = Extract<
  Declared,
  readonly [Name, unknown]
>[1]["columns"][number];

type StoredIn<Kind> = Kind extends ColumnKind<infer Stored> ? Stored : never;

/** The row a table stores: each column, and the value it holds. */
export type RowOf<Name extends TableName> = {
  [Each in ColumnOf<Name> as Each[0]]: StoredIn<Each[1]>;
};

/** The name a join uses for a referring column: the column without `_id`. */
type JoinKey<ColumnName> = ColumnName extends `${infer Key}_id` ? Key : never;

/** The referring columns of a table, by the name a join uses for each. */
type ReferringColumns<Name extends TableName> = {
  [Each in ColumnOf<Name> as Each[1] extends RefersTo<string>
    ? JoinKey<Each[0]>
    : never]: Each[1];
};

/** The names a join can follow from a table. */
export type ReferenceOf<Name extends TableName> = keyof ReferringColumns<Name> &
  string;

/** The table that a reference points at. */
export type TargetOf<Name extends TableName, Key extends ReferenceOf<Name>> =
  ReferringColumns<Name>[Key] extends RefersTo<infer Target extends TableName>
    ? Target
    : never;

/** Whether the referring column can hold nothing. */
export type IsOptional<Name extends TableName, Key extends ReferenceOf<Name>> =
  null extends StoredIn<ReferringColumns<Name>[Key]> ? true : false;

/** The references of `From` that point at `To`. */
export type ReferenceTo<From extends TableName, To extends TableName> = {
  [Key in ReferenceOf<From>]: TargetOf<From, Key> extends To ? Key : never;
}[ReferenceOf<From>];

/** The word a query calls each table by: its name as one singular word. */
/* jscpd:ignore-start -- a list of strings, not code */
const SINGULAR: Record<TableName, string> = {
  activity_log: "activity",
  address_cache: "cachedAddress",
  answers: "answer",
  answers_at_booking: "bookedAnswer",
  api_keys: "apiKey",
  attendee_answers: "attendeeAnswer",
  attendee_statuses: "status",
  attendees: "attendee",
  attribute_options: "attributeOption",
  attributes: "attribute",
  booking_tax_assessments: "assessment",
  built_sites: "builtSite",
  checkout_pending_answers: "pendingAnswer",
  checkout_stages: "checkoutStage",
  contact_preferences: "contactPreference",
  email_templates: "emailTemplate",
  external_source_links: "externalSourceLink",
  external_sources: "externalSource",
  group_listings: "groupListing",
  groups: "groupRow",
  holidays: "holiday",
  image_uses: "imageUse",
  images: "image",
  invoices: "invoice",
  listing_attendees: "listingAttendee",
  listing_attribute_options: "listingAttributeOption",
  listing_parents: "listingParent",
  listing_prices: "listingPrice",
  listing_questions: "listingQuestion",
  listings: "listing",
  login_attempts: "loginAttempt",
  logistics_agents: "logisticsAgent",
  maintenance_tasks: "maintenanceTask",
  modifier_groups: "modifierGroup",
  modifier_listings: "modifierListing",
  modifier_usages: "modifierUsage",
  modifiers: "modifier",
  news_posts: "newsPost",
  payment_case_decisions: "paymentCaseDecision",
  payment_cases: "paymentCase",
  payment_charges: "charge",
  payment_completion_deliveries: "completionDelivery",
  payment_completion_effects: "completionEffect",
  payment_sessions: "paymentSession",
  processed_payments: "payment",
  processed_scan_operations: "scanOperation",
  processed_sms_inbound: "inboundSms",
  questions: "question",
  refund_confirmation_references: "refundConfirmationReference",
  refund_confirmations: "refundConfirmation",
  schema_migrations: "schemaMigration",
  service_costs: "serviceCost",
  sessions: "session",
  settings: "setting",
  site_page_items: "sitePageItem",
  site_pages: "sitePage",
  sms_messages: "smsMessage",
  square_link_ends: "squareLinkEnd",
  strings: "string",
  sumup_checkouts: "sumupCheckout",
  system_notes: "systemNote",
  token_attempts: "tokenAttempt",
  transfers: "transfer",
  user_logistics_agents: "userLogisticsAgent",
  users: "user",
};
/* jscpd:ignore-end */

/** One table, as a read holds it. */
export type TableHandle<Name extends TableName = TableName> = {
  readonly name: Name;
  /** The word a query calls the table by, unless the read names another. */
  readonly singular: string;
  readonly columns: readonly Column[];
};

const handleOf = ([name, table]: (typeof TYPED_SCHEMA)[number]): [
  string,
  TableHandle,
] => [name, { columns: table.columns, name, singular: SINGULAR[name] }];

const handles = new Map(TYPED_SCHEMA.map(handleOf));

/** Every declared table, by name. */
export const tables = Object.fromEntries(handles) as {
  readonly [Name in TableName]: TableHandle<Name>;
};

/** Where a reference leads: the referring column, the table it points at, and
 *  whether the column can hold nothing. */
export type Reference = {
  readonly column: string;
  readonly target: TableHandle;
  readonly optional: boolean;
};

/** The reference `key` of a table. The types refuse a key that is not a
 *  reference, so a miss here is a broken declaration. */
export const referenceOf = (table: TableHandle, key: string): Reference => {
  const column = `${key}_id`;
  const declared = table.columns.find(([name]) => name === column);
  if (declared === undefined) {
    throw new Error(`${table.name} has no ${column} column to join along`);
  }
  const facts = columnFacts(declared[1]);
  if (facts.refersTo === null) {
    throw new Error(`${table.name}.${column} does not refer to a table`);
  }
  return {
    column,
    optional: facts.canBeNull,
    target: requiredMapValue(
      handles,
      facts.refersTo,
      `${table.name}.${column} refers to ${facts.refersTo}, which is not a declared table`,
    ),
  };
};
