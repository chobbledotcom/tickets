/** Schema version label and the migrations bookkeeping table name. */

export const LATEST_UPDATE =
  "Delete image records whose stored filename is an encrypted empty string.";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
