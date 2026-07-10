import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { insert, setDb } from "#shared/db/client.ts";
import { initDb } from "#shared/db/migrations.ts";
import { setupTestEncryptionKey } from "#test-utils";
import {
  createLegacyMigrationHarness,
  expectAttendeeCols,
  LEGACY_DB_SCHEMA_HASH,
  LEGACY_DB_UPDATE,
  seedLegacySchemaMarkers,
} from "./helpers.ts";

describe("db > listing_attendees migration from legacy schema (partial state)", () => {
  const h = createLegacyMigrationHarness();
  afterEach(h.cleanup);

  test("drops PII columns when listing_id was dropped in a prior partial run", async () => {
    setupTestEncryptionKey();
    const client = await h.newFileDb();
    setDb(client);

    // Simulate a DB in the intermediate state: listing_id and its relatives
    // have already been dropped (e.g. by a partial earlier migration), but
    // the pre-pii_blob PII columns are still present with NOT NULL.
    await client.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seedLegacySchemaMarkers(client);
    await client.execute(`CREATE TABLE attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      payment_id TEXT,
      created TEXT NOT NULL,
      ticket_token_index TEXT,
      pii_blob TEXT NOT NULL DEFAULT '',
      checked_in TEXT NOT NULL DEFAULT '',
      price_paid TEXT
    )`);

    await client.execute(
      insert("attendees", {
        created: "2024-03-01T00:00:00Z",
        email: "alice@example.com",
        id: 1,
        name: "Alice",
        pii_blob: "encrypted-data",
        ticket_token_index: "tok_abc",
      }),
    );

    await initDb();

    await expectAttendeeCols(
      client,
      ["address", "email", "name", "payment_id", "phone"],
      ["pii_blob", "ticket_token_index"],
    );

    const rows = await client.execute("SELECT * FROM attendees WHERE id = 1");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.created).toBe("2024-03-01T00:00:00Z");
    expect(rows.rows[0]!.pii_blob).toBe("encrypted-data");
    expect(rows.rows[0]!.ticket_token_index).toBe("tok_abc");
  });

  test("fails instead of marking progress for unknown legacy attendee shape", async () => {
    setupTestEncryptionKey();
    const client = await h.newFileDb();
    setDb(client);

    await client.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seedLegacySchemaMarkers(client);
    await client.execute(`CREATE TABLE attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      created TEXT NOT NULL
    )`);

    await expect(initDb()).rejects.toThrow("missing expected legacy column");

    const markerRows = await client.execute(
      "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
    );
    expect(markerRows.rows.map((row) => [row.key, row.value])).toEqual([
      ["db_schema_hash", LEGACY_DB_SCHEMA_HASH],
      ["latest_db_update", LEGACY_DB_UPDATE],
    ]);

    const migrationRows = await client.execute(
      "SELECT id FROM schema_migrations",
    );
    expect(migrationRows.rows.length).toBe(0);

    // The advisory lock must be released on failure so a retry isn't
    // blocked until the lock TTL expires.
    const lockRows = await client.execute(
      "SELECT 1 FROM settings WHERE key = 'migration_lock'",
    );
    expect(lockRows.rows.length).toBe(0);
  });
});
