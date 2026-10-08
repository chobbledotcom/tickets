/** Schema version label and the migrations bookkeeping table name. */

export const LATEST_UPDATE =
  "Pad the stored holiday dates the pre-2476 mapper wrote unpadded.";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
export const LATEST_DB_UPDATE_KEY = "latest_db_update";
export const DB_SCHEMA_HASH_KEY = "db_schema_hash";
export const MIGRATION_LOCK_KEY = "migration_lock";
