import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { setDb } from "#db/client.ts";
import { initDb, invalidateInitDbCache } from "#db/migrations.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import {
  createLegacyMigrationHarness,
  expectAttendeeCols,
  LEGACY_DB_SCHEMA_HASH,
  LEGACY_DB_UPDATE,
  stubPragmaForeignKeysOff,
} from "#test/integration/db/legacy-migration/helpers.ts";
import { expectAttendeeRow } from "#test-utils/attendee-rows.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

describe("db > listing_attendees migration from legacy schema (backfill)", () => {
  const h = createLegacyMigrationHarness();
  afterEach(h.cleanup);

  test("migration backfills listing_attendees, listing duration, and processed_payments", async () => {
    const client = await h.createLegacyDb();

    await client.execute(
      insertInto(tables.listings, {
        created: "2024-01-01T00:00:00Z",
        id: 1,
        max_attendees: 100,
        name: await encrypt("Test Listing"),
      }),
    );
    await client.execute(
      sql`INSERT INTO attendees (checked_in_v2, created, date, email, id, listing_id, name, price_paid_v2, quantity, refunded_v2)
        VALUES (${0}, ${"2024-01-01T00:00:00Z"}, ${"2024-06-15"}, ${"test@example.com"}, ${1}, ${1}, ${"Test User"}, ${1000}, ${2}, ${0})`,
    );
    await client.execute(
      insertInto(tables.processed_payments, {
        attendee_id: 1,
        payment_session_id: "ps_test_123",
        processed_at: "2024-01-01T00:00:00Z",
      }),
    );

    using _pragmaStub = stubPragmaForeignKeysOff(client);
    await initDb();

    const listings = await client.execute(
      sql`SELECT duration_days FROM listings`,
    );
    expect(listings.rows[0]!.duration_days).toBe(1);

    const ea = await client.execute(sql`SELECT * FROM listing_attendees`);
    expect(ea.rows.length).toBe(1);
    expect(ea.rows[0]!.listing_id).toBe(1);
    expect(ea.rows[0]!.attendee_id).toBe(1);
    expect(ea.rows[0]!.quantity).toBe(2);
    // price_paid is no longer a column — a booking's amount projects from the
    // transfers ledger. Like the dropped refunded flag, the legacy price_paid_v2
    // value isn't carried by the reconcile (no live site predates the ledger).
    expect(Object.hasOwn(ea.rows[0]!, "price_paid")).toBe(false);
    expect(ea.rows[0]!.start_at).toBe("2024-06-15T00:00:00Z");
    expect(ea.rows[0]!.end_at).toBe("2024-06-16T00:00:00Z");

    // price_paid is dropped — amount paid is a per-row listing_attendees figure
    // (ledger-projected), never an attendees column.
    await expectAttendeeCols(
      client,
      [
        "address",
        "date",
        "email",
        "listing_id",
        "name",
        "payment_id",
        "phone",
        "price_paid",
        "quantity",
      ],
      ["id", "pii_blob"],
    );

    const payments = await client.execute(
      sql`SELECT * FROM processed_payments`,
    );
    expect(payments.rows.length).toBe(1);
    expect(payments.rows[0]!.attendee_id).toBe(1);
  });

  test("skips table recreation when attendees already matches schema", async () => {
    setupTestEncryptionKey();
    const client = await h.newFileDb();
    setDb(client);

    // Run initDb on a fresh DB so everything is created and up to date
    await initDb({ allowMissingSettings: true });

    // Insert a row so we can verify it's untouched (not lost to a spurious recreation)
    await client.execute(
      sql`INSERT INTO attendees (created, id, pii_blob, ticket_token_index)
        VALUES (${"2024-05-01T00:00:00Z"}, ${1}, ${"blob-data"}, ${"tok_skip"})`,
    );

    // Force a named migration re-run by making legacy markers stale and
    // clearing named migration history.
    await client.execute(
      sql`UPDATE settings SET value = ${LEGACY_DB_UPDATE} WHERE key = 'latest_db_update'`,
    );
    await client.execute(
      sql`UPDATE settings SET value = ${LEGACY_DB_SCHEMA_HASH} WHERE key = 'db_schema_hash'`,
    );
    await client.execute(sql`DROP TABLE schema_migrations`);
    invalidateInitDbCache();
    await initDb();

    await expectAttendeeCols(client, [], ["id", "pii_blob", "created"]);
    await expectAttendeeRow(client, 1, {
      pii_blob: "blob-data",
      ticket_token_index: "tok_skip",
    });
  });
});
