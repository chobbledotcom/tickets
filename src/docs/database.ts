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

export * from "#shared/db/activityLog.ts";
export * from "#shared/db/attendees.ts";
export * from "#shared/db/client.ts";
export * from "#shared/db/common-schema.ts";
export * from "#shared/db/define-id-table.ts";
export * from "#shared/db/events.ts";
export * from "#shared/db/groups.ts";
export * from "#shared/db/holidays.ts";
export * from "#shared/db/login-attempts.ts";
export * from "#shared/db/migrations.ts";
export * from "#shared/db/processed-payments.ts";
export * from "#shared/db/query.ts";
export * from "#shared/db/query-log.ts";
export * from "#shared/db/sessions.ts";
export * from "#shared/db/settings.ts";
export * from "#shared/db/table.ts";
export * from "#shared/db/users.ts";
