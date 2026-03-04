/**
 * Types for the ticket reservation system
 */

/** Individual contact field name */
export type ContactField = "email" | "phone" | "address" | "special_instructions";

/** All valid contact field names (runtime array matching the ContactField union) */
export const CONTACT_FIELDS: readonly ContactField[] = ["email", "phone", "address", "special_instructions"];

/** Type guard: check if an arbitrary string is a valid ContactField */
export const isContactField = (s: string): s is ContactField =>
  (CONTACT_FIELDS as readonly string[]).includes(s);

/** Contact fields setting for an event (comma-separated ContactField names, or empty for name-only) */
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

/** Event type: standard (one-time) or daily (date-based booking) */
export type EventType = "standard" | "daily";

/** Valid event type values */
const EVENT_TYPES: readonly EventType[] = ["standard", "daily"];

/** Type guard: check if an arbitrary string is a valid EventType */
export const isEventType = (s: string): s is EventType =>
  (EVENT_TYPES as readonly string[]).includes(s);

/** Whether an event can accept payments (has a price or allows pay-what-you-want) */
export const isPaidEvent = (event: Pick<Event, "unit_price" | "can_pay_more">): boolean =>
  event.unit_price > 0 || event.can_pay_more;

/** Absolute minimum for the pay-more max price cap (in minor units) */
export const CAN_PAY_MORE_ABS_MIN = 10000;

/** Multiplier applied to unit_price for the pay-more max price cap */
export const CAN_PAY_MORE_MULTIPLIER = 10;

/** Calculate the maximum price for a can_pay_more event (in minor units).
 *  Returns the higher of (10 × minPrice) or 10000. */
export const canPayMoreMaxPrice = (minPrice: number): number =>
  Math.max(minPrice * CAN_PAY_MORE_MULTIPLIER, CAN_PAY_MORE_ABS_MIN);

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
  non_transferable: boolean;
  can_pay_more: boolean;
  hidden: boolean;
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
}

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

/** Type guard: check if a string is a valid AdminLevel */
export const isAdminLevel = (s: string): s is AdminLevel =>
  s === "owner" || s === "manager";

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
  terms_and_conditions: string;
}

export interface EventWithCount extends Event {
  attendee_count: number;
}
