/** Schema version label and the migrations bookkeeping table name. */

export const LATEST_UPDATE =
  "Name the booking order each refund reverses, so one returned order no longer marks a person's other orders refunded.";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
export const LATEST_DB_UPDATE_KEY = "latest_db_update";
export const DB_SCHEMA_HASH_KEY = "db_schema_hash";
export const MIGRATION_LOCK_KEY = "migration_lock";
