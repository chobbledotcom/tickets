/**
 * Types for attendee operations
 */

import type { Attendee, ContactFields, ContactInfo } from "#lib/types.ts";

/** Aggregated statistics for active events */
export type ActiveEventStats = {
  income: number;
  tickets: number;
  attendees: number;
};

/** Encrypted attendee data for insertion */
export type EncryptedAttendeeData = {
  created: string;
  ticketToken: string;
  ticketTokenIndex: string;
  encryptedPiiBlob: string;
};

/** Input for encrypting attendee fields */
export type EncryptInput = ContactInfo & {
  paymentId: string;
  pricePaid: number;
};

/** Input for building an Attendee result from an insert */
export type BuildAttendeeInput = ContactInfo & {
  insertId: number | bigint | undefined;
  eventId: number;
  created: string;
  paymentId: string;
  quantity: number;
  pricePaid: number;
  ticketToken: string;
  ticketTokenIndex: string;
  date: string | null;
};

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendees: Attendee[] }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** A single event booking within a multi-event attendee creation */
export type EventBooking = {
  eventId: number;
  quantity?: number;
  pricePaid?: number;
  date?: string | null;
  /** Booking duration in days (defaults to 1 for 1-day bookings). Only meaningful when date is set. */
  durationDays?: number;
};

/** Input for creating an attendee atomically (one or more events) */
export type AttendeeInput = ContactFields & {
  paymentId?: string;
  bookings: EventBooking[];
};

/** Row from event_attendees — per-event booking data */
export type EventAttendeeRow = {
  event_id: number;
  start_at: string | null;
  end_at: string | null;
  quantity: number;
  checked_in: number;
  refunded: number;
  price_paid: number;
  attachment_downloads: number;
};

/** An attendee with all their event bookings (for token resolution) */
export type AttendeeWithBookings = {
  /** Base attendee fields (PII, token, created — shared across events) */
  id: number;
  created: string;
  ticket_token: string;
  ticket_token_index: string;
  pii_blob: string;
  /** Per-event bookings, sorted by start_at then event_id */
  bookings: EventAttendeeRow[];
};

/** Item for batch availability check */
export type BatchAvailabilityItem = {
  eventId: number;
  quantity: number;
  /** Duration in days for multi-day bookings (defaults to 1 when absent). */
  durationDays?: number;
};

/** Input for updating attendee PII (shared across events) */
export type UpdateAttendeePIIInput = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  /** Decrypted payment_id for PII blob rebuild (from existing attendee) */
  payment_id: string;
  /** Decrypted ticket_token for PII blob rebuild (from existing attendee) */
  ticket_token: string;
};

/** Input for updating a single event link */
export type UpdateEventLinkInput = {
  quantity: number;
  date: string | null;
  /** Duration in days (defaults to 1). Only meaningful when date is set. */
  durationDays?: number;
};

/** Result of updating an event link */
export type UpdateEventLinkResult =
  | { success: true }
  | { success: false; reason: "capacity_exceeded" };
