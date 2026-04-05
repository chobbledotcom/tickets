/**
 * Types for the ticket reservation system
 */

/** Create a type guard from a readonly array of string literal values */
export const createTypeGuard =
  <T extends string>(values: readonly T[]) =>
  (s: string): s is T =>
    (values as readonly string[]).includes(s);

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
export type PaymentProviderType = "stripe" | "square";

/** Valid payment provider values */
const PAYMENT_PROVIDERS: readonly PaymentProviderType[] = ["stripe", "square"];

/** Type guard: check if a string is a valid PaymentProviderType */
export const isPaymentProvider = createTypeGuard(PAYMENT_PROVIDERS);

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
  id: number;
  name: string;
  description: string;
  date: string; // encrypted UTC ISO datetime or empty string
  location: string; // encrypted or empty string
  slug: string;
  slug_index: string;
  group_id: number;
  created: string;
  max_attendees: number;
  thank_you_url: string;
  unit_price: number;
  max_quantity: number;
  webhook_url: string;
  active: boolean;
  fields: EventFields;
  closes_at: string | null;
  event_type: EventType;
  bookable_days: string[];
  minimum_days_before: number;
  maximum_days_after: number;
  image_url: string;
  attachment_url: string;
  attachment_name: string;
  non_transferable: boolean;
  can_pay_more: boolean;
  max_price: number;
  hidden: boolean;
  purchase_only: boolean;
}

export interface Attendee extends ContactInfo {
  id: number;
  event_id: number;
  created: string;
  payment_id: string;
  quantity: number;
  price_paid: string;
  checked_in: boolean;
  refunded: boolean;
  ticket_token: string;
  ticket_token_index: string;
  date: string | null;
  attachment_downloads: number;
  pii_blob: string;
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
  token: string; // Contains the hashed token for DB storage
  csrf_token: string;
  expires: number;
  wrapped_data_key: string | null;
  user_id: number;
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
};

export interface User {
  id: number;
  username_hash: string; // encrypted at rest, decrypted to display
  username_index: string; // HMAC hash for lookups
  password_hash: string; // PBKDF2 hash encrypted at rest
  wrapped_data_key: string | null; // wrapped with user's KEK
  admin_level: string; // encrypted "owner" or "manager"
  invite_code_hash: string | null; // encrypted SHA-256 of invite token, null after password set
  invite_expiry: string | null; // encrypted ISO 8601, null after password set
}

export interface ApiKey {
  id: number;
  user_id: number;
  key_index: string; // HMAC hash for lookup
  wrapped_data_key: string; // DATA_KEY wrapped with the API key token
  name: string; // encrypted label
  created: string;
  last_used: string; // ISO 8601 or empty string
}

export interface Holiday {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
}

export interface Group {
  id: number;
  slug: string;
  slug_index: string;
  name: string;
  description: string;
  terms_and_conditions: string;
  max_attendees: number;
  hidden: boolean;
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
