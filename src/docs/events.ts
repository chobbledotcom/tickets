/**
 * Event management: fields, sorting, and availability.
 *
 * Events come in two types:
 * - **Standard** — fixed capacity with optional date
 * - **Daily** — date-based booking with holiday exclusions
 *
 * @module
 */

export * from "#lib/dates.ts";
export * from "#lib/event-fields.ts";
export * from "#lib/sort-events.ts";
