/**
 * Database client, ORM abstractions, and entity tables.
 *
 * The database layer uses libsql with a type-safe table abstraction
 * that handles column definitions, field transformers (encrypt/decrypt),
 * and generic CRUD operations.
 *
 * ## Entity Tables
 *
 * - **Events** — event CRUD with cached encrypted slugs/names
 * - **Attendees** — hybrid RSA+AES encryption for PII
 * - **Users** — password hashing, admin levels, wrapped keys
 * - **Sessions** — token hashing with TTL caching
 * - **Groups** — event grouping with encrypted names
 * - **Settings** — system configuration (currency, email, payment keys)
 * - **Holidays** — date exclusions for daily events
 * - **Activity Log** — admin audit trail
 * - **Processed Payments** — idempotency tracking
 * - **Login Attempts** — rate limiting and lockout
 *
 * @module
 */

export * from "#lib/db/client.ts";
export * from "#lib/db/table.ts";
export * from "#lib/db/query.ts";
export * from "#lib/db/migrations.ts";
export * from "#lib/db/common-schema.ts";
export * from "#lib/db/define-id-table.ts";
export * from "#lib/db/query-log.ts";
export * from "#lib/db/events.ts";
export * from "#lib/db/attendees.ts";
export * from "#lib/db/users.ts";
export * from "#lib/db/settings.ts";
export * from "#lib/db/sessions.ts";
export * from "#lib/db/groups.ts";
export * from "#lib/db/holidays.ts";
export * from "#lib/db/processed-payments.ts";
export * from "#lib/db/activityLog.ts";
export * from "#lib/db/login-attempts.ts";
