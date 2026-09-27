/** Schema version label and the migrations bookkeeping table name. */

export const LATEST_UPDATE =
  "Stage a checkout's typed answers beside its session id, so the emails can show them without the owner key.";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
export const LATEST_DB_UPDATE_KEY = "latest_db_update";
export const DB_SCHEMA_HASH_KEY = "db_schema_hash";
export const MIGRATION_LOCK_KEY = "migration_lock";
