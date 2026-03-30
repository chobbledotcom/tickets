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
  | { success: true; attendee: Attendee }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** Input for creating an attendee atomically */
export type AttendeeInput = ContactFields & {
  eventId: number;
  paymentId?: string;
  quantity?: number;
  pricePaid?: number;
  date?: string | null;
};

/** Item for batch availability check */
export type BatchAvailabilityItem = { eventId: number; quantity: number };

/** Input for updating an attendee */
export type UpdateAttendeeInput = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  event_id: number;
  quantity: number;
  /** Decrypted payment_id for PII blob rebuild (from existing attendee) */
  payment_id: string;
  /** Decrypted ticket_token for PII blob rebuild (from existing attendee) */
  ticket_token: string;
};

/** Result of a migration batch */
export type MigrateBatchResult = {
  migrated: number;
  remaining: number;
};
