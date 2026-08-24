import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryOne } from "#db/client.ts";
import attendeeListingsTagMigration from "#db/migrations/2026-07-03_attendee_listings_tag.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

// Data-only migration: it reads and rewrites one settings row via getDb.
const context = buildMigrationContext({});
const runMigration = () => attendeeListingsTagMigration(context).up();

const setStoredTemplate = (value: string): Promise<unknown> =>
  getDb().execute({
    args: [value],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('attendee_column_order', ?)",
  });

const storedTemplate = async (): Promise<string | null> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'attendee_column_order'",
  );
  return row?.value ?? null;
};

describeWithEnv(
  "db > migrations > 2026-07-03_attendee_listings_tag",
  { db: true },
  () => {
    test("rewrites {{listing}} to {{listings}} preserving the rest of the template", async () => {
      await setStoredTemplate("{{name}}, {{listing}}, {{email}}");
      await runMigration();
      expect(await storedTemplate()).toBe("{{name}}, {{listings}}, {{email}}");
    });

    test("rewrites the tag with inner whitespace and a trailing filter", async () => {
      await setStoredTemplate("{{ listing }}, {{listing | upcase}}");
      await runMigration();
      expect(await storedTemplate()).toBe(
        "{{ listings }}, {{listings | upcase}}",
      );
    });

    test("leaves an already-migrated {{listings}} tag alone (idempotent re-run)", async () => {
      await setStoredTemplate("{{listings}}, {{name}}");
      await runMigration();
      expect(await storedTemplate()).toBe("{{listings}}, {{name}}");
    });

    test("is a no-op when the setting is unset", async () => {
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'attendee_column_order'",
      );
      await runMigration();
      expect(await storedTemplate()).toBe(null);
    });
  },
);
