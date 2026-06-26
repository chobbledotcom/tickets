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
  indexExists,
  kindOf,
} from "#test-utils";

// jscpd:ignore-end

const MIGRATION_ID = "2026-06-24_attendees_kind";
const NOT_NULL_MIGRATION_ID = "2026-06-26_attendees_kind_not_null";
const attendeesTable = SCHEMA.find(([name]) => name === "attendees")![1];

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
    // Guards the wishful `/* NOT NULL */` comment hack: the invariant must be a
    // real constraint, not a comment, and the `IS NULL` escape (which left
    // NULL-kind rows that consumed capacity as neither attendee nor servicing)
    // must be gone from the CHECK.
    expect(type).not.toContain("/* NOT NULL */");
    expect(type).not.toContain("IS NULL");
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

describe("servicing §1 — the NOT NULL tightening migration is registered", () => {
  test("the 2026-06-26_attendees_kind_not_null migration is appended to MIGRATIONS", () => {
    expect(MIGRATIONS.some((m) => m.id === NOT_NULL_MIGRATION_ID)).toBe(true);
  });

  test("the NOT NULL migration runs after the kind migration (column exists to tighten)", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    const kindIdx = ids.indexOf(MIGRATION_ID);
    const notNullIdx = ids.indexOf(NOT_NULL_MIGRATION_ID);
    expect(kindIdx).toBeGreaterThanOrEqual(0);
    expect(notNullIdx).toBeGreaterThan(kindIdx);
  });
});

describeWithEnv(
  "servicing §1 — kind is a real NOT NULL invariant (no limbo rows)",
  { db: true },
  () => {
    const kindNotNull = async (): Promise<number> => {
      const result = await getDb().execute("PRAGMA table_info(attendees)");
      const row = result.rows.find((r) => r.name === "kind");
      return Number(row?.notnull ?? 0);
    };

    const limboCount = async (): Promise<number> => {
      const result = await getDb().execute(
        "SELECT COUNT(*) AS count FROM attendees WHERE kind IS NULL",
      );
      return Number(result.rows[0]?.count ?? 0);
    };

    test("PRAGMA table_info(attendees).notnull === 1 for the kind column", async () => {
      expect(await kindNotNull()).toBe(1);
    });

    test("INSERT of a NULL-kind row is rejected by the constraint (no limbo row)", async () => {
      await expect(
        getDb().execute({
          args: ["limbo"],
          sql:
            "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) " +
            "VALUES ('2026-01-01T00:00:00Z', ?, '', NULL)",
        }),
      ).rejects.toThrow();
      expect(await limboCount()).toBe(0);
    });

    test("UPDATE setting kind = NULL is rejected by the constraint", async () => {
      const listing = await createTestListing();
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Real",
        "x@example.com",
      );
      await expect(
        getDb().execute({
          args: [attendee.id],
          sql: "UPDATE attendees SET kind = NULL WHERE id = ?",
        }),
      ).rejects.toThrow();
      expect(await kindOf(attendee.id)).toBe(ATTENDEE_KIND);
    });

    test("the NOT NULL migration is idempotent on an already-NOT NULL database", async () => {
      const migration = MIGRATIONS.find((m) => m.id === NOT_NULL_MIGRATION_ID)!;
      expect(await kindNotNull()).toBe(1);
      await migration.up();
      expect(await kindNotNull()).toBe(1);
      expect(await limboCount()).toBe(0);
    });
  },
);
