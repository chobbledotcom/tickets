import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  LATEST_UPDATE,
  MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#db/migrations/schema/version.ts";

describe("db > migrations > schema version", () => {
  // These names are stored data: a site's settings rows and its migrations
  // bookkeeping table keep them forever, so a rename would orphan them.
  test("names the migrations bookkeeping table and its setting keys", () => {
    expect(SCHEMA_MIGRATIONS_TABLE).toBe("schema_migrations");
    expect(LATEST_DB_UPDATE_KEY).toBe("latest_db_update");
    expect(DB_SCHEMA_HASH_KEY).toBe("db_schema_hash");
    expect(MIGRATION_LOCK_KEY).toBe("migration_lock");
  });

  test("labels the newest update with its stored sentence", () => {
    // The sentence is what an upgrading site reads as its last applied
    // update, so the label is the migration's identity, not a comment.
    expect(LATEST_UPDATE).toBe(
      "Store every listing's contact fields as trimmed, comma-joined tokens.",
    );
  });
});
