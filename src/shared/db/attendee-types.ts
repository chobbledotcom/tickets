/**
 * Types for attendee operations
 */

import type { BookingSource } from "#shared/db/contact-preferences.ts";
import type { Attendee, ContactFields, ContactInfo } from "#shared/types.ts";

/** Aggregated statistics for active listings */
export type ActiveListingStats = {
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
  listingId: number;
  created: string;
  paymentId: string;
  quantity: number;
  pricePaid: number;
  ticketToken: string;
  ticketTokenIndex: string;
  date: string | null;
  durationDays?: number;
  remainingBalance: number;
  statusId: number | null;
};

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendees: Attendee[] }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** A single listing booking within a multi-listing attendee creation */
export type ListingBooking = {
  listingId: number;
  quantity?: number;
  pricePaid?: number;
  date?: string | null;
  /** Booking duration in days (defaults to 1 for 1-day bookings). Only meaningful when date is set. */
  durationDays?: number;
};

/** A concrete booking line — every field resolved (unlike the optional-field
 * `ListingBooking` cart input). Used by capacity checks and the booking builder. */
export type LineBooking = {
  listingId: number;
  quantity: number;
  date: string | null;
  durationDays: number;
};

/** Input for creating an attendee atomically (one or more listings) */
export type AttendeeInput = ContactFields & {
  paymentId?: string;
  bookings: ListingBooking[];
  /** Order-level remaining balance in minor units (plaintext). Defaults to 0. */
  remainingBalance?: number;
  /** Owner-defined status id assigned to the new attendee. */
  statusId?: number | null;
  /** When true the per-booking capacity guard is dropped so the bookings are
   * inserted unconditionally. Admin manual add only — public/webhook callers
   * leave it false so capacity is always enforced. */
  allowOverbook?: boolean;
  /** Booking origin, used to split the per-contact booking count between online
   * checkouts and admin manual adds. Defaults to "public" so a newly added
   * checkout path can never be silently left uncounted; the admin manual-add
   * paths pass "admin" explicitly. */
  source?: BookingSource;
};

/** Row from listing_attendees — per-listing booking data */
export type ListingAttendeeRow = {
  listing_id: number;
  start_at: string | null;
  end_at: string | null;
  quantity: number;
  checked_in: number;
  refunded: number;
  price_paid: number;
  attachment_downloads: number;
};

/** An attendee with all their listing bookings (for token resolution) */
export type AttendeeWithBookings = {
  /** Base attendee fields (PII, token, created — shared across listings) */
  id: number;
  created: string;
  ticket_token: string;
  ticket_token_index: string;
  pii_blob: string;
  /** Order-level remaining balance in minor units (plaintext). */
  remaining_balance: number;
  /** Owner-defined status id (plaintext); null for legacy/default. */
  status_id: number | null;
  /** Per-listing bookings, sorted by start_at then listing_id */
  bookings: ListingAttendeeRow[];
};

/** Item for batch availability check */
export type BatchAvailabilityItem = {
  listingId: number;
  quantity: number;
  /** Duration in days for multi-day bookings (defaults to 1 when absent). */
  durationDays?: number;
};

/** Input for updating attendee PII (shared across listings) */
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

/**
 * A desired final-state listing line for the atomic attendee edit path.
 * One per listing registration the operator wants the attendee to end up with.
 * Shared by the admin form model (which builds it) and the DB edit helper
 * (which applies it) so the shape is defined once.
 */
export type DesiredListingLine = {
  /** Stable identity of the existing row (`${listingId}|${startAt}`). Empty
   * string for newly-added lines. */
  key: string;
  listingId: number;
  quantity: number;
  /** YYYY-MM-DD for daily listings, null otherwise. */
  date: string | null;
  /** Duration (days) — only meaningful for daily listings. Defaults to 1. */
  durationDays: number;
  /** True when the line carries an existing listing_attendees identity. */
  exists: boolean;
};
