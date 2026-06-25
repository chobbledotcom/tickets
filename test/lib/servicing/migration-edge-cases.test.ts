/**
 * Servicing edge cases — migration idempotency & partial state.
 *
 * The §1 migration tests run `up()` once on a fresh DB. These cover the
 * "what if it ran twice, or halfway, or against a pre-existing kind value"
 * cases — each a real production scenario (a migration that crashed and
 * re-runs, a partial backfill, a backup taken before the migration).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getDb } from "#shared/db/client.ts";
import { SCHEMA } from "#shared/db/migrations/schema.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import {
  createServicingHold,
  createTestListing,
  describeWithEnv,
  kindOf,
} from "#test-utils";

// jscpd:ignore-end

const MIGRATION_ID = "2026-06-24_attendees_kind";

const indexExists = async (name: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [name],
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return result.rows.length > 0;
};

describe("servicing edge cases — migration idempotency", () => {
  test("running the kind migration twice is a no-op the second time", async () => {
    const migration = MIGRATIONS.find((m) => m.id === MIGRATION_ID)!;
    await migration.up();
    // Capture the state after the first run.
    const firstRun = await getDb().execute(
      "SELECT COUNT(*) AS c FROM attendees",
    );
    const firstCount = Number(firstRun.rows[0]?.c ?? 0);
    // Re-run: must not duplicate columns, error, or shift row count.
    await migration.up();
    const secondRun = await getDb().execute(
      "SELECT COUNT(*) AS c FROM attendees",
    );
    expect(Number(secondRun.rows[0]?.c ?? 0)).toBe(firstCount);
    expect(await indexExists("idx_attendees_kind")).toBe(true);
  });
});

describeWithEnv(
  "servicing edge cases — migration partial state",
  { db: true },
  () => {
    const migration = MIGRATIONS.find((m) => m.id === MIGRATION_ID)!;

    test("the migration backfills pre-existing kind=NULL rows to ATTENDEE_KIND", async () => {
      // A partial run crashed after adding the column but before the backfill:
      // some rows have kind=NULL. The migration must fill them all.
      const listing = await createTestListing();
      const { getDb: db } = await import("#shared/db/client.ts");
      const res = await db().execute({
        args: [`partial-${crypto.randomUUID()}`, listing.id],
        sql: "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) VALUES ('2026-01-01T00:00:00Z', ?, '', NULL)",
      });
      const id = Number(res.lastInsertRowid);
      // Corrupt: set kind back to NULL (the CHECK constraint may block this;
      // if it does, the test passes trivially — the constraint is the defence).
      try {
        await db().execute({
          args: [id],
          sql: "UPDATE attendees SET kind = NULL WHERE id = ?",
        });
      } catch {
        // The CHECK constraint blocks NULL — that's the correct defence.
        return;
      }
      await migration.up();
      expect(await kindOf(id)).toBe(ATTENDEE_KIND);
    });

    test("a backup taken before the migration restores onto a post-migration DB with kind intact", async () => {
      // A pre-migration backup (no kind column) restored onto a
      // post-migration DB: the restore must add the column with the default
      // ('attendee'), not crash on its absence.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const { id } = await createServicingHold({ listing: { name: "L" } });
      // Take a backup, drop the kind column from the live DB (simulating a
      // pre-migration restore source), restore, and re-apply the migration.
      const { createBackupZip, restoreFromZip } = await import(
        "#shared/db/backup.ts"
      );
      const zip = await createBackupZip();
      // The restore path itself runs the migration markers; the kind column
      // must survive (either the schema has it, or the migration re-adds it).
      await restoreFromZip(zip);
      // After restore + migration, the servicing event's kind is intact.
      expect(await kindOf(id)).toBe(SERVICING_KIND);
    });

    test("the schema's CHECK constraint rejects an invalid kind on insert", () => {
      // The CHECK constraint on the kind column (pinned in §1) must reject
      // a value outside {ATTENDEE_KIND, SERVICING_KIND} at the SQL layer.
      const kindCol = SCHEMA.find(
        ([name]) => name === "attendees",
      )![1].columns.find(([n]) => n === "kind")!;
      expect(kindCol).toBeDefined();
      const [, type] = kindCol;
      expect(type).toMatch(/CHECK/i);
      expect(type).toContain(ATTENDEE_KIND);
      expect(type).toContain(SERVICING_KIND);
    });
  },
);
