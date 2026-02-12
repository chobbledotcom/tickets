/**
 * Types for the ticket reservation system
 */

/** Contact fields setting for an event (comma-separated: "email", "phone", "address") */
export type EventFields = string;

/** Attendee contact details — the core PII fields collected at registration */
export type ContactInfo = {
  name: string;
  email: string;
  phone: string;
  address: string;
};

/** Event type: standard (one-time) or daily (date-based booking) */
export type EventType = "standard" | "daily";

export interface Event {
  id: number;
  name: string;
  description: string;
  slug: string;
  slug_index: string;
  created: string;
  max_attendees: number;
  thank_you_url: string | null;
  unit_price: number | null;
  max_quantity: number;
  webhook_url: string | null;
  active: number;
  fields: EventFields;
  closes_at: string | null;
  event_type: EventType;
  bookable_days: string;
  minimum_days_before: number;
  maximum_days_after: number;
}

export interface Attendee extends ContactInfo {
  id: number;
  event_id: number;
  created: string;
  payment_id: string | null;
  quantity: number;
  price_paid: string | null;
  checked_in: string;
  ticket_token: string;
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

/** Session data needed by admin page templates */
export type AdminSession = {
  readonly csrfToken: string;
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

export interface EventWithCount extends Event {
  attendee_count: number;
}
