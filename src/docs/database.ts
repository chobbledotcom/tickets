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

export * from "#shared/db/activityLog.ts";
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
} from "#shared/db/attendee-types.ts";
export * from "#shared/db/attendees/api.ts";
export {
  type AtomicDesiredLine,
  type ExistingLine,
  lineKeyFromBooking,
  loadExistingLines,
  type UpdateAttendeeAtomicResult,
} from "#shared/db/attendees/atomic-update.ts";
export * from "#shared/db/attendees/capacity/checks.ts";
export * from "#shared/db/attendees/capacity/groups.ts";
export * from "#shared/db/attendees/capacity/range.ts";
export * from "#shared/db/attendees/capacity/remaining.ts";
export type { ListingCapacityRow } from "#shared/db/attendees/capacity/types.ts";
export {
  type BookingBatchPlan,
  buildAttendeeInsert,
} from "#shared/db/attendees/create.ts";
export * from "#shared/db/attendees/delete.ts";
export * from "#shared/db/attendees/pii.ts";
export * from "#shared/db/attendees/queries.ts";
export * from "#shared/db/attendees/stats.ts";
export * from "#shared/db/attendees/tokens.ts";
export * from "#shared/db/attendees/update.ts";
export * from "#shared/db/client.ts";
export * from "#shared/db/common-schema.ts";
export * from "#shared/db/define-id-table.ts";
export * from "#shared/db/groups.ts";
export * from "#shared/db/holidays.ts";
export * from "#shared/db/listings/aggregates.ts";
export * from "#shared/db/listings/attendees.ts";
export * from "#shared/db/listings/catalog.ts";
export * from "#shared/db/listings/delete.ts";
export * from "#shared/db/listings/records.ts";
export * from "#shared/db/listings/select.ts";
export * from "#shared/db/listings/table.ts";
export * from "#shared/db/login-attempts.ts";
export * from "#shared/db/migrations.ts";
export * from "#shared/db/processed-payments.ts";
export * from "#shared/db/query.ts";
export * from "#shared/db/query-log.ts";
export * from "#shared/db/sessions.ts";
export * from "#shared/db/settings.ts";
export * from "#shared/db/table.ts";
export * from "#shared/db/users.ts";
