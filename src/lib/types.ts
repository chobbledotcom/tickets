/**
 * Types for the ticket reservation system
 */

export interface Event {
  id: number;
  created: string;
  name: string;
  description: string;
  max_attendees: number;
  thank_you_url: string;
  unit_price: number | null;
}

export interface Attendee {
  id: number;
  event_id: number;
  name: string;
  email: string;
  created: string;
  stripe_payment_id: string | null;
}

export interface Settings {
  key: string;
  value: string;
}

export interface Session {
  token: string;
  expires: number;
}

export interface EventWithCount extends Event {
  attendee_count: number;
}
