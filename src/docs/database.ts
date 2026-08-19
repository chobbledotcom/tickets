/**
 * Database client, ORM abstractions, and entity tables.
 *
 * The database layer uses libsql with a type-safe table abstraction
 * that handles column definitions, field transformers (encrypt/decrypt),
 * and generic CRUD operations.
 *
 * ## Entity Tables
 *
 * - **Listings** — listing CRUD with cached encrypted slugs/names
 * - **Attendees** — hybrid RSA+AES encryption for PII
 * - **Users** — password hashing, admin levels, wrapped keys
 * - **Sessions** — token hashing with TTL caching
 * - **Groups** — listing grouping with encrypted names
 * - **Settings** — system configuration (currency, email, payment keys)
 * - **Holidays** — date exclusions for daily listings
 * - **Activity Log** — admin audit trail
 * - **Processed Payments** — idempotency tracking
 * - **Login Attempts** — rate limiting and lockout
 *
 * @module
 */

export * from "#db/activity-log.ts";
// The attendee surface spans the split modules under attendees/*. api.ts owns
// the stubbable atomic operations, while the implementation modules below are
// re-exported by explicit list to keep one public route to those operations.
export type {
  ActiveListingStats,
  AttendeeInput,
  AttendeeWithBookings,
  BatchAvailabilityItem,
  CreateAttendeeResult,
  ListingAttendeeRow,
  ListingBooking,
  UpdateAttendeePIIInput,
} from "#db/attendee-types.ts";
export * from "#db/attendees/api.ts";
export {
  type AtomicDesiredLine,
  type ExistingLine,
  lineKeyFromBooking,
  loadExistingLines,
  type UpdateAttendeeAtomicResult,
} from "#db/attendees/atomic-update.ts";
export * from "#db/attendees/capacity/checks.ts";
export * from "#db/attendees/capacity/groups.ts";
export * from "#db/attendees/capacity/range.ts";
export * from "#db/attendees/capacity/remaining.ts";
export type { ListingCapacityRow } from "#db/attendees/capacity/types.ts";
export {
  type BookingBatchPlan,
  buildAttendeeInsert,
} from "#db/attendees/create.ts";
export * from "#db/attendees/delete.ts";
export * from "#db/attendees/pii.ts";
export * from "#db/attendees/queries.ts";
export * from "#db/attendees/stats.ts";
export * from "#db/attendees/tokens.ts";
export * from "#db/attendees/update.ts";
export * from "#db/client.ts";
export * from "#db/common-schema.ts";
export * from "#db/define-id-table.ts";
export * from "#db/groups.ts";
export * from "#db/holidays.ts";
export * from "#db/listings/aggregates.ts";
export * from "#db/listings/attendees.ts";
export * from "#db/listings/catalog.ts";
export * from "#db/listings/delete.ts";
export * from "#db/listings/records.ts";
export * from "#db/listings/select.ts";
export * from "#db/listings/table.ts";
export * from "#db/login-attempts.ts";
export * from "#db/migrations.ts";
export * from "#db/processed-payments.ts";
export * from "#db/query.ts";
export * from "#db/query-log.ts";
export * from "#db/sessions.ts";
export * from "#db/settings.ts";
export * from "#db/table.ts";
export * from "#db/users.ts";
