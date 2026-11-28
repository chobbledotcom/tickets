// effects: pure
/**
 * Every table as a read sees it. Each table has the type of its stored row,
 * the columns that refer to another table, and the word a query calls it by.
 *
 * All of it comes from the schema declaration, apart from the stored types
 * that the codecs in `#db/codecs/columns.ts` name. A column that the schema
 * does not declare is a compile error in a read.
 */

import type { CODECS } from "#db/codecs/columns.ts";
import type { AppOf, StoredOf } from "#db/codecs/kinds.ts";
import { TYPED_SCHEMA } from "#db/migrations/schema/index.ts";
import { REFERENCES } from "#db/migrations/schema/references.ts";
import { columnFacts } from "#db/migrations/schema/scalar-columns.ts";
import type {
  Column,
  ColumnKind,
  Filling,
} from "#db/migrations/schema/types.ts";
import {
  type CamelCased,
  type CamelWord,
  columnName,
  type SnakeWord,
} from "#shared/column-names.ts";

type Declared = (typeof TYPED_SCHEMA)[number];

/** The name of a declared table. */
export type TableName = Declared[0];

type ColumnOf<Name extends TableName> = Extract<
  Declared,
  readonly [Name, unknown]
>[1]["columns"][number];

type StoredIn<Kind> =
  Kind extends ColumnKind<infer Stored, Filling> ? Stored : never;

/** The columns of a table that a new row can leave out. */
type OptionalColumnOf<Name extends TableName> = {
  [Each in ColumnOf<Name> as Each[1] extends ColumnKind<unknown, "optional">
    ? Each[0]
    : never]: true;
};

/** The row of a table as its column types alone give it. */
export type DeclaredRow<Name extends TableName> = {
  [Each in ColumnOf<Name> as Each[0]]: StoredIn<Each[1]>;
};

/** The codecs of one table, or none. */
type CodecsOf<Name> = Name extends keyof typeof CODECS
  ? (typeof CODECS)[Name]
  : Record<never, never>;

type StoredAt<Row, Column> = Column extends keyof Row ? Row[Column] : never;

/** The columns of one table whose codec stores a value that its declared
 *  column cannot hold. */
type UnfitIn<Name extends keyof typeof CODECS> = {
  [Column in keyof CodecsOf<Name>]: StoredOf<
    CodecsOf<Name>[Column]
  > extends StoredAt<DeclaredRow<Name>, Column>
    ? never
    : Column;
}[keyof CodecsOf<Name>];

/** Every codec that stores a value that its column cannot hold. */
type Unfit = {
  [Name in keyof typeof CODECS]: UnfitIn<Name>;
}[keyof typeof CODECS];

/** A row of a table, with each column read through `Through`. A codec that
 *  does not fit its column leaves every row with no type. */
type RowThrough<Name extends TableName, Stored extends boolean> = [
  Unfit,
] extends [never]
  ? {
      [Column in keyof DeclaredRow<Name>]: Column extends keyof CodecsOf<Name>
        ? Stored extends true
          ? StoredOf<CodecsOf<Name>[Column]>
          : AppOf<CodecsOf<Name>[Column]>
        : StoredAt<DeclaredRow<Name>, Column>;
    }
  : never;

/** The row a table stores, under its column names. Only SQL text and the
 *  codecs name a column this way. */
type StoredColumns<Name extends TableName> = RowThrough<Name, true>;

/** The row a table stores: each field, and the value it holds. */
export type RowOf<Name extends TableName> = CamelCased<StoredColumns<Name>>;

/** The row the code reads: each field through its codec. */
export type DecodedRowOf<Name extends TableName> = CamelCased<
  RowThrough<Name, false>
>;

/** The stored fields that the database can fill (`Optional` true), or the
 *  ones it cannot (false). */
type FillableFields<
  Name extends TableName,
  Optional extends boolean,
> = CamelCased<{
  [Column in keyof StoredColumns<Name> as (
    Column extends keyof OptionalColumnOf<Name>
      ? true
      : false
  ) extends Optional
    ? Column
    : never]: StoredColumns<Name>[Column];
}>;

/** A new row of a table: every field that the database cannot fill, and any
 *  of the others. */
export type NewRowOf<Name extends TableName> = FillableFields<Name, false> &
  Partial<FillableFields<Name, true>>;

/** The referring columns of a table, and the table each one points at. */
type ReferencesOf<Name extends TableName> = Name extends keyof typeof REFERENCES
  ? (typeof REFERENCES)[Name]
  : Record<never, never>;

/** The name a join uses for a referring column: the field without `Id`. */
type JoinKey<ColumnName> = ColumnName extends `${infer Key}_id`
  ? CamelWord<Key>
  : never;

/** The referring column behind a join key. */
type ReferringColumn<Key extends string> = `${SnakeWord<Key>}_id`;

/** The names a join can follow from a table. */
export type ReferenceOf<Name extends TableName> = JoinKey<
  keyof ReferencesOf<Name>
>;

/** The table that a reference points at. */
export type TargetOf<
  Name extends TableName,
  Key extends ReferenceOf<Name>,
> = ReferencesOf<Name>[ReferringColumn<Key> & keyof ReferencesOf<Name>] &
  TableName;

/** Whether the referring column can hold nothing. */
export type IsOptional<Name extends TableName, Key extends ReferenceOf<Name>> =
  null extends StoredAt<StoredColumns<Name>, ReferringColumn<Key>>
    ? true
    : false;

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
  redirects: "redirect",
  refund_confirmation_references: "refundConfirmationReference",
  refund_confirmations: "refundConfirmation",
  reviews: "review",
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

/** One table, as a read holds it. Code over any table holds a table that the
 *  schema does not declare, with its name as text. */
export type TableHandle<Name extends string = TableName> = {
  readonly name: Name;
  /** The word a query calls the table by, unless the read names another. */
  readonly singular: string;
  readonly columns: readonly Column[];
};

const handleOf = ([name, table]: (typeof TYPED_SCHEMA)[number]): [
  string,
  TableHandle,
] => [name, { columns: table.columns, name, singular: SINGULAR[name] }];

/** Every declared table, by name. */
export const tables = Object.fromEntries(TYPED_SCHEMA.map(handleOf)) as {
  readonly [Name in TableName]: TableHandle<Name>;
};

/** The declared references, for a table that code names by text. */
const REFERENCES_BY_TABLE: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = REFERENCES;

/** Where a reference leads: the referring column, the table it points at, and
 *  whether the column can hold nothing. */
export type Reference = {
  readonly column: string;
  readonly target: TableHandle;
  readonly optional: boolean;
};

/** The reference `key` of a table. The types refuse a key that is not a
 *  reference, so a miss here is a broken declaration. */
export const referenceOf = (
  table: TableHandle<string>,
  key: string,
): Reference => {
  const column = `${columnName(key)}_id`;
  const declared = table.columns.find(([name]) => name === column);
  if (declared === undefined) {
    throw new Error(`${table.name} has no ${column} column to join along`);
  }
  const targets: Readonly<Record<string, string>> | undefined =
    REFERENCES_BY_TABLE[table.name];
  const target = targets?.[column];
  if (target === undefined) {
    throw new Error(`${table.name}.${column} does not refer to a table`);
  }
  return {
    column,
    optional: columnFacts(declared[1]).canBeNull,
    target: tableNamed(target),
  };
};

/** The declared table of this name. Code over any table holds the name as
 *  text. */
export const tableNamed = (name: string): TableHandle => {
  if (!Object.hasOwn(tables, name)) {
    throw new Error(`${name} is not a declared table`);
  }
  return tables[name as TableName];
};

/** The tables whose rows have an `id` column. */
export type TableWithId = {
  [Name in TableName]: "id" extends keyof RowOf<Name> ? Name : never;
}[TableName];
