import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import migrationDefinition from "#shared/db/migrations/2026-07-17_checkout_stage_provider_id.ts";
import { recreateTable } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

describeWithEnv("db > checkout provider id migration", { db: true }, () => {
  test("discards dormant rows and rebuilds the runtime table", async () => {
    await getDb().execute("DROP TABLE checkout_stages");
    await getDb().execute(`CREATE TABLE checkout_stages (
      payment_session_id TEXT PRIMARY KEY NOT NULL,
      attendee_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      ticket_tokens TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    await getDb().execute(`INSERT INTO checkout_stages
      (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
      VALUES ('dormant', 42, 'stripe', 'encrypted', 'booked', '2026-07-16T00:00:00Z')`);
    const migration = migrationDefinition(
      buildMigrationContext({ recreateTable }),
    );

    expect({
      description: migration.description,
      id: migration.id,
      requires: migration.requires,
    }).toEqual({
      description: "Replace dormant checkout stages with the runtime schema.",
      id: "2026-07-17_checkout_stage_provider_id",
      requires: {},
    });
    await migration.up();
    await migration.verify();

    const rows = await getDb().execute(
      "SELECT payment_session_id FROM checkout_stages",
    );
    expect(rows.rows).toEqual([]);
    const columns = await getDb().execute("PRAGMA table_info(checkout_stages)");
    expect(columns.rows.map((row) => row.name)).toContain(
      "provider_checkout_id",
    );
  });
});
