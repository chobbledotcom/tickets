/**
 * Types for the ticket reservation system
 */

/** Contact fields setting for an event */
export type EventFields = "email" | "phone" | "both";

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
}

export interface Attendee {
  id: number;
  event_id: number;
  name: string;
  email: string;
  phone: string;
  created: string;
  payment_id: string | null;
  quantity: number;
  price_paid: string | null;
  checked_in: string;
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
}

export interface EventWithCount extends Event {
  attendee_count: number;
}
