/**
 * Servicing §1 — migration & schema.
 *
 * The `kind` column turns `attendees` into a discriminated table: customer
 * rows are `kind='attendee'`, capacity-only holds are `kind='servicing'`. The
 * column must default existing rows to `'attendee'` (so the migration is
 * non-destructive), be indexed (every customer surface filters on it), and be
 * declared in `SCHEMA` so the schema-hash guard stays in sync with a named
 * migration registered in `MIGRATIONS`.
 *
 * Implementation contract (test-first — code not yet written):
 *   - `#shared/db/migrations/schema.ts` declares the `kind` column
 *     (`TEXT NOT NULL DEFAULT 'attendee'`) on `attendees` plus
 *     `idx_attendees_kind` in that table's `indexes`.
 *   - `#shared/db/migrations/2026-06-24_attendees_kind.ts` is a
 *     `schemaMigration` whose `requires` lists the column + `idx_attendees_kind`
 *     (the Codex-flagged `indexes` omission must NOT recur — see
 *     `migration is registered …` and `kind index is created by the migration`).
 *   - `#shared/db/migrations.ts` appends that migration to `MIGRATIONS`.
 *   - `#shared/db/attendees/kind.ts` exports `ATTENDEE_KIND` / `SERVICING_KIND`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { createBackupZip, restoreFromZip } from "#shared/db/backup.ts";
import { getDb } from "#shared/db/client.ts";
import { SCHEMA } from "#shared/db/migrations/schema.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import {
  createTestAttendeeDirect,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  kindOf,
} from "#test-utils";

// jscpd:ignore-end

const MIGRATION_ID = "2026-06-24_attendees_kind";
const attendeesTable = SCHEMA.find(([name]) => name === "attendees")![1];

const indexExists = async (name: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [name],
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return result.rows.length > 0;
};

const columnDefault = async (): Promise<string | null> => {
  const result = await getDb().execute({
    args: ["kind"],
    sql: "SELECT dflt_value FROM pragma_table_info('attendees') WHERE name = ?",
  });
  return (result.rows[0]?.dflt_value as string | null) ?? null;
};

describe("servicing §1 — schema declares the kind column + index", () => {
  test("the attendees schema carries a NOT NULL kind column defaulting to ATTENDEE_KIND", () => {
    const kindCol = attendeesTable.columns.find(([name]) => name === "kind");
    expect(kindCol).toBeDefined();
    const [, type] = kindCol!;
    expect(type).toMatch(/NOT NULL/);
    expect(type).toContain(ATTENDEE_KIND);
  });

  test("the attendees schema declares idx_attendees_kind", () => {
    const names = (attendeesTable.indexes ?? []).map((i) => i.name);
    expect(names).toContain("idx_attendees_kind");
  });

  test("the kind column's allowed values are ATTENDEE_KIND and SERVICING_KIND only", () => {
    const [, type] = attendeesTable.columns.find(([n]) => n === "kind")!;
    expect(type).toContain(ATTENDEE_KIND);
    expect(type).toContain(SERVICING_KIND);
    expect(type).toMatch(/CHECK/i);
  });
});

describe("servicing §1 — migration is registered and runs on an existing database", () => {
  test("the migration is appended to MIGRATIONS (guards the manual-registration gap)", () => {
    expect(MIGRATIONS.some((m) => m.id === MIGRATION_ID)).toBe(true);
  });

  describeWithEnv("servicing §1 — migration up()", { db: true }, () => {
    const migration = MIGRATIONS.find((m) => m.id === MIGRATION_ID)!;

    test("kind column defaults existing attendees to ATTENDEE_KIND", async () => {
      expect(await columnDefault()).toContain(ATTENDEE_KIND);
      await migration.up();
      expect(await columnDefault()).toContain(ATTENDEE_KIND);
    });

    test("kind index is created by the migration (guards the requires.indexes omission)", async () => {
      await getDb().execute("DROP INDEX IF EXISTS idx_attendees_kind");
      expect(await indexExists("idx_attendees_kind")).toBe(false);
      await migration.up();
      expect(await indexExists("idx_attendees_kind")).toBe(true);
    });

    test("existing attendee rows are backfilled to ATTENDEE_KIND (no null kind)", async () => {
      const listing = await createTestListing();
      await createTestAttendeeDirect(listing.id, "Existing", "x@example.com");
      await migration.up();
      const rows = await getDb().execute({
        args: [ATTENDEE_KIND],
        sql: "SELECT kind FROM attendees WHERE kind IS NULL OR kind <> ?",
      });
      expect(rows.rows.length).toBe(0);
    });
  });
});

describeWithEnv(
  "servicing §1 — backup then restore round-trips the kind column",
  { db: true },
  () => {
    test("a servicing event survives a backup/restore cycle with kind='servicing' intact", async () => {
      const { id } = await createTestServicingEvent({
        bookings: [
          {
            listingId: (await createTestListing({ maxAttendees: 10 })).id,
            quantity: 2,
          },
        ],
        name: "Boiler Service",
      });
      await restoreFromZip(await createBackupZip());
      expect(await kindOf(id)).toBe(SERVICING_KIND);
    });
  },
);

describe("servicing §1 — schema and migration stay in sync", () => {
  test("the migration's requires declares the kind column and idx_attendees_kind", () => {
    const migration = MIGRATIONS.find((m) => m.id === MIGRATION_ID)!;
    const requires = (
      migration as unknown as {
        requires?: {
          columns?: Record<string, unknown>;
          indexes?: string[];
        };
      }
    ).requires;
    expect(requires?.columns?.kind).toBeDefined();
    expect(requires?.indexes).toContain("idx_attendees_kind");
  });
});
