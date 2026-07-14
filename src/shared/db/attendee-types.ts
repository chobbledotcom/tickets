/**
 * Types for attendee operations
 */

import type { BlindIndex, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type { AttendeeKind } from "#shared/db/attendees/kind.ts";
import type { BookingSource } from "#shared/db/contact-tokens.ts";
import type { Attendee, ContactFields, ContactInfo } from "#shared/types.ts";

/** Per-(child, parent) unit allocation from the booking fold: the quantity of
 * `childId` chosen under `parentId` in one order. An order where the same child
 * appears under two parents has two entries (distinct parentIds); the summed
 * `qty` over all entries for one child equals that child's `quantities` map
 * value.
 * Used by `expandChildAllocations` to produce one `listing_attendees` row per
 * entry instead of one summed row. */
export type ChildAllocation = {
  childId: number;
  parentId: number;
  qty: number;
};

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
  ticketTokenIndex: BlindIndex;
  encryptedPiiBlob: OwnerKeyEncrypted;
};

/** Input for encrypting attendee fields */
export type EncryptInput = ContactInfo & {
  paymentId: string;
};

/** Input for building an Attendee result from an insert */
export type BuildAttendeeInput = ContactInfo & {
  insertId: number | bigint | undefined;
  listingId: number;
  created: string;
  kind: string;
  paymentId: string;
  quantity: number;
  pricePaid: number;
  ticketToken: string;
  ticketTokenIndex: BlindIndex;
  date: string | null;
  durationDays?: number;
  remainingBalance: number;
  statusId: number | null;
  /** Package group this booking row belongs to (0 = not a package). */
  packageGroupId: number;
};

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendees: Attendee[] }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** The success arm of an atomic create, for call sites whose input makes
 * failure impossible: a quantity-0 overbook insert has no capacity gate, and
 * if the PII can't encrypt the whole system is already broken — we don't
 * defend against that. */
export type CreateAttendeeSuccess = Extract<
  CreateAttendeeResult,
  { success: true }
>;

/** A single listing booking within a multi-listing attendee creation */
export type ListingBooking = {
  listingId: number;
  quantity?: number;
  pricePaid?: number;
  date?: string | null;
  /** Booking duration in days (defaults to 1 for 1-day bookings). Only meaningful when date is set. */
  durationDays?: number;
  /** Shared per-order token written on every row of one checkout (defaults to
   * "" — legacy/parent-less bookings). Set once per create, not per caller. */
  orderToken?: string;
  /** The parent listing this row was folded under when it is a chosen child
   * (defaults to 0 — not a folded child). */
  parentListingId?: number;
  /** The package this row was booked through (defaults to 0 — not part of any
   * package). Stamped per row by the caller (`stampBookingPackages`) — an order
   * can carry several packages — so tickets/emails group each line under the
   * right bundle by this id. */
  packageGroupId?: number | undefined;
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
  /** Discriminator for attendee-like rows. Defaults to the customer attendee kind. */
  kind?: AttendeeKind;
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
  /** Exact ticket token to encrypt and index. Paid recovery prepares this once;
   * other create paths omit it and receive a fresh token. */
  ticketToken?: string;
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
  ledger_event_group: string;
  attachment_downloads: number;
  /** Per-order token shared by every row created in one checkout; "" for legacy
   * rows and parent-less bookings. */
  order_token: string;
  /** Parent listing this row was folded under (a chosen child); 0 otherwise. */
  parent_listing_id: number;
  /** The package group this order belongs to; 0 when not a package order. */
  package_group_id: number;
};

/** An attendee with all their listing bookings (for token resolution) */
export type AttendeeWithBookings = {
  /** Base attendee fields (PII, token, created — shared across listings) */
  id: number;
  created: string;
  kind: string;
  ticket_token: string;
  ticket_token_index: BlindIndex;
  pii_blob: OwnerKeyEncrypted;
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
  /** Per-line date. When omitted, the batch's shared date is used. */
  date?: string | null;
  /** Duration in days for multi-day bookings (defaults to 1 when absent). */
  durationDays?: number;
};

/** Contact PII plus the decrypted identifiers needed to rebuild a PII blob:
 * the {@link ContactInfo} fields alongside the attendee's `payment_id` and
 * `ticket_token`. The single shape used to (re)build an encrypted PII blob. */
export type AttendeePii = ContactInfo & {
  /** Decrypted payment_id for PII blob rebuild (from existing attendee) */
  payment_id: string;
  /** Decrypted ticket_token for PII blob rebuild (from existing attendee) */
  ticket_token: string;
  /** Latitude pinned by an operator ("" = not pinned; never set at booking) */
  lat: string;
  /** Longitude pinned by an operator ("" = not pinned; never set at booking) */
  lng: string;
};

/** Input for updating attendee PII (shared across listings) */
export type UpdateAttendeePIIInput = AttendeePii;

/**
 * A desired final-state listing line for the atomic attendee edit path.
 * One per listing registration the operator wants the attendee to end up with.
 * Shared by the admin form model (which builds it) and the DB edit helper
 * (which applies it) so the shape is defined once.
 */
export type DesiredListingLine = {
  /** Stable identity of the existing row
   * (`${listingId}|${startAt}|${parentListingId}|${packageGroupId}`). Empty
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
  /** The package path this row belongs to (0/absent = none) — part of the
   * row's slot identity, so an edit targets the right row when the same
   * listing was booked through two packages. */
  packageGroupId?: number;
  /** The parent this row was folded under as an add-on (0/absent = none) —
   * the last slot-identity dimension, so a child booked under a parent and
   * the same listing's own standalone row never read as one duplicate slot.
   * Only an EXISTING row carries a parent; the admin form never creates
   * folded-child rows. */
  parentListingId?: number;
};
