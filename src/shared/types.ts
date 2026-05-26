/**
 * Types for the ticket reservation system
 */

/** Create a type guard from a readonly array of string literal values */
export const createTypeGuard =
  <T extends string>(values: readonly T[]) =>
  (s: string): s is T =>
    (values as readonly string[]).includes(s);

/**
 * Unique identifiers for settings nags that prompt the admin to complete
 * required or recommended configuration.
 */
export type NagId =
  | "payment-provider"
  | "business-email"
  | "domain"
  | "superuser";

/**
 * A single settings nag item presented to the admin.
 */
export type NagItem = {
  /** The nag identifier. */
  id: NagId;
  /** Human-readable description of what needs to be configured. */
  label: string;
  /** Deep link to the settings form where the value can be set. */
  href: string;
};

export type SuperuserChoice = "" | "self-managed" | "enabled";

const SUPERUSER_CHOICES: readonly SuperuserChoice[] = [
  "",
  "self-managed",
  "enabled",
];

export const isSuperuserChoice = createTypeGuard(SUPERUSER_CHOICES);

/** Individual contact field name */
export type ContactField =
  | "email"
  | "phone"
  | "address"
  | "special_instructions";

/** All valid contact field names (runtime array matching the ContactField union) */
export const CONTACT_FIELDS: readonly ContactField[] = [
  "email",
  "phone",
  "address",
  "special_instructions",
];

/** Type guard: check if an arbitrary string is a valid ContactField */
export const isContactField = createTypeGuard(CONTACT_FIELDS);

/**
 * Contact fields setting for an event (comma-separated ContactField names, or empty for name-only).
 * Alias kept for documentation; runtime enforcement happens in parseEventFields.
 */
export type EventFields = string;

/** Attendee contact details — the core PII fields collected at registration */
export type ContactInfo = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
};

/** Required name+email with optional phone/address/special_instructions from ContactInfo */
export type ContactFields = Pick<ContactInfo, "name" | "email"> &
  Partial<Pick<ContactInfo, "phone" | "address" | "special_instructions">>;

/** UI theme */
export type Theme = "light" | "dark";

/** Supported payment provider identifiers */
export type PaymentProviderType = "stripe" | "square" | "sumup";

/** Valid payment provider values */
const PAYMENT_PROVIDERS: readonly PaymentProviderType[] = [
  "stripe",
  "square",
  "sumup",
];

/** Type guard: check if a string is a valid PaymentProviderType */
export const isPaymentProvider = createTypeGuard(PAYMENT_PROVIDERS);

/** Persisted payment-provider setting: an explicit provider, "none" (admin saved
 *  payments-disabled), or absent (never saved — drives the settings nag). */
export type PaymentProviderSetting = PaymentProviderType | "none";

const PAYMENT_PROVIDER_SETTINGS: readonly PaymentProviderSetting[] = [
  "stripe",
  "square",
  "sumup",
  "none",
];

/** Type guard: check if a string is a valid PaymentProviderSetting */
export const isPaymentProviderSetting = createTypeGuard(
  PAYMENT_PROVIDER_SETTINGS,
);

/** Event type: standard (one-time) or daily (date-based booking) */
export type EventType = "standard" | "daily";

/** Valid event type values */
const EVENT_TYPES: readonly EventType[] = ["standard", "daily"];

/** Type guard: check if an arbitrary string is a valid EventType */
export const isEventType = createTypeGuard(EVENT_TYPES);

/** Whether an event can accept payments (has a price or allows pay-what-you-want) */
export const isPaidEvent = (
  event: Pick<Event, "unit_price" | "can_pay_more">,
): boolean => event.unit_price > 0 || event.can_pay_more;

export interface Event {
  active: boolean;
  assign_built_site: boolean;
  attachment_name: string;
  attachment_url: string;
  bookable_days: string[];
  can_pay_more: boolean;
  closes_at: string | null;
  created: string;
  date: string; // encrypted UTC ISO datetime or empty string
  description: string;
  event_type: EventType;
  fields: EventFields;
  group_id: number;
  hidden: boolean;
  id: number;
  image_url: string;
  location: string; // encrypted or empty string
  max_attendees: number;
  max_price: number;
  max_quantity: number;
  maximum_days_after: number;
  minimum_days_before: number;
  name: string;
  non_transferable: boolean;
  purchase_only: boolean;
  slug: string;
  slug_index: string;
  thank_you_url: string;
  unit_price: number;
  webhook_url: string;
  months_per_unit: number;
  initial_site_months: number;
  duration_days: number;
}

export interface Attendee extends ContactInfo {
  attachment_downloads: number;
  checked_in: boolean;
  created: string;
  date: string | null;
  event_id: number;
  id: number;
  payment_id: string;
  pii_blob: string;
  price_paid: string;
  quantity: number;
  refunded: boolean;
  ticket_token: string;
  ticket_token_index: string;
}

/** Short keys used in the PII blob JSON to minimize encrypted payload size */
export type PiiBlob = {
  v: number; // schema version (1 = current)
  n: string; // name
  e: string; // email
  p: string; // phone
  a: string; // address
  s: string; // special_instructions
  pi: string; // payment_id
  t: string; // ticket_token
};

export interface Settings {
  key: string;
  value: string;
}

export interface Session {
  csrf_token: string;
  expires: number;
  token: string; // Contains the hashed token for DB storage
  user_id: number;
  wrapped_data_key: string | null;
}

/** Admin role levels */
export type AdminLevel = "owner" | "manager";

/** Valid admin level values */
const ADMIN_LEVELS: readonly AdminLevel[] = ["owner", "manager"];

/** Type guard: check if a string is a valid AdminLevel */
export const isAdminLevel = createTypeGuard(ADMIN_LEVELS);

/** Session data needed by admin page templates */
export type AdminSession = {
  readonly adminLevel: AdminLevel;
  readonly settingsNagItems?: readonly NagItem[];
};

export interface User {
  admin_level: string; // encrypted "owner" or "manager"
  id: number;
  invite_code_hash: string | null; // encrypted SHA-256 of invite token, null after password set
  invite_expiry: string | null; // encrypted ISO 8601, null after password set
  password_hash: string; // PBKDF2 hash encrypted at rest
  username_hash: string; // encrypted at rest, decrypted to display
  username_index: string; // HMAC hash for lookups
  wrapped_data_key: string | null; // wrapped with user's KEK
}

export interface ApiKey {
  created: string;
  id: number;
  key_index: string; // HMAC hash for lookup
  last_used: string; // ISO 8601 or empty string
  name: string; // encrypted label
  user_id: number;
  wrapped_data_key: string; // DATA_KEY wrapped with the API key token
}

export interface Holiday {
  end_date: string;
  id: number;
  name: string;
  start_date: string;
}

export interface Group {
  description: string;
  hidden: boolean;
  id: number;
  max_attendees: number;
  name: string;
  slug: string;
  slug_index: string;
  terms_and_conditions: string;
}

export interface EventWithCount extends Event {
  attendee_count: number;
}

/**
 * Admin API event shape — all event fields except internal indices.
 * Used by both admin JSON API and admin templates to ensure consistent
 * field exposure. Snake_case keys match the DB schema.
 */
export type AdminEvent = Omit<EventWithCount, "slug_index">;

/** A single row in the attendee table (attendee + parent event context) */
export type AttendeeTableRow = {
  attendee: Attendee;
  eventId: number;
  eventName: string;
};
