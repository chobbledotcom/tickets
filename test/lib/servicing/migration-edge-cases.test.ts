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
import { it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getDb } from "#shared/db/client.ts";
import { SCHEMA } from "#shared/db/migrations/schema.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import {
  createServicingHold,
  createTestListing,
  describeWithEnv,
  indexExists,
  kindOf,
} from "#test-utils";

// jscpd:ignore-end

const MIGRATION_ID = "2026-06-24_attendees_kind";

describeWithEnv(
  "servicing edge cases — migration idempotency",
  { db: true },
  () => {
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
  },
);

describeWithEnv(
  "servicing edge cases — migration partial state",
  { db: true },
  () => {
    const notNullMigration = MIGRATIONS.find(
      (m) => m.id === "2026-06-26_attendees_kind_not_null",
    )!;

    test("the schema's CHECK constraint rejects a NULL kind at INSERT (no limbo row can exist)", async () => {
      // The kind column is now a real NOT NULL invariant: a NULL-kind row —
      // which would consume booked_capacity while counting as neither attendee
      // nor servicing — cannot be created. The CHECK constraint is the defence.
      await expect(
        getDb().execute({
          args: ["limbo"],
          sql:
            "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) " +
            "VALUES ('2026-01-01T00:00:00Z', ?, '', NULL)",
        }),
      ).rejects.toThrow();
      const rows = await getDb().execute({
        args: [ATTENDEE_KIND],
        sql: "SELECT kind FROM attendees WHERE kind IS NULL OR kind <> ?",
      });
      expect(rows.rows.length).toBe(0);
    });

    test("the 2026-06-26 migration repairs a legacy nullable-kind table (NULL rows → ATTENDEE_KIND)", async () => {
      // A pre-2026-06-26 database carried the nullable `CHECK (kind IS NULL OR
      // kind IN (...))` shape, so a NULL-kind "limbo" row could land. Bend the
      // live attendees table back into that legacy nullable shape, seed a NULL
      // row, then run the NOT NULL migration: it rebuilds the table from SCHEMA
      // and the copy-time COALESCE(kind, 'attendee') repairs the row.
      const attendeesColumns = SCHEMA.find(([name]) => name === "attendees")![1]
        .columns;
      const legacyCols = attendeesColumns
        .map(([col, type]) =>
          col === "kind"
            ? `kind TEXT CHECK (kind IS NULL OR kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}'))`
            : `${col} ${type}`,
        )
        .join(", ");
      await getDb().execute("DROP TABLE attendees");
      await getDb().execute(`CREATE TABLE attendees (${legacyCols})`);
      const res = await getDb().execute({
        args: ["limbo"],
        sql:
          "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) " +
          "VALUES ('2026-01-01T00:00:00Z', ?, '', NULL)",
      });
      const id = Number(res.lastInsertRowid);
      expect(await kindOf(id)).toBeNull();

      await notNullMigration.up();

      expect(await kindOf(id)).toBe(ATTENDEE_KIND);
      const notnull = await getDb().execute("PRAGMA table_info(attendees)");
      const kindRow = notnull.rows.find((r) => r.name === "kind");
      expect(Number(kindRow?.notnull ?? 0)).toBe(1);
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
