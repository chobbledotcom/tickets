import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { setDb } from "#shared/db/client.ts";
import {
  applySchemaChanges,
  recreateTable,
} from "#shared/db/migrations/schema-sync.ts";
import { resetDb } from "#test-utils";

/**
 * Guards the free-text migration's table rebuilds. An existing database carries
 * the pre-feature column constraints (attendee_answers.answer_id NOT NULL and
 * questions.display_type's CHECK without 'free_text'). The additive schema sync
 * can only ADD COLUMNs, so it cannot relax either — the migration must rebuild
 * both tables, which is what this verifies.
 */
describe("db > free-text migration constraint relaxation", () => {
  afterEach(() => {
    resetDb();
  });

  /** A database shaped as it was before the free-text feature shipped. */
  const seedLegacyDb = async () => {
    const db = createClient({ url: ":memory:" });
    setDb(db);
    await db.execute(
      `CREATE TABLE attendee_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendee_id INTEGER NOT NULL,
        answer_id INTEGER NOT NULL
      )`,
    );
    await db.execute(
      `CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL DEFAULT '',
        display_type TEXT NOT NULL DEFAULT 'radio'
          CHECK (display_type IN ('radio', 'select'))
      )`,
    );
    // Brings in the rest of the schema (answers, strings, …) and ADD COLUMNs
    // question_id/string_id, but leaves answer_id NOT NULL and the old CHECK.
    await applySchemaChanges();
    return db;
  };

  test("additive sync alone leaves the legacy constraints in place", async () => {
    const db = await seedLegacyDb();

    await expect(
      db.execute(
        "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text')",
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        "INSERT INTO attendee_answers (attendee_id, question_id, string_id) VALUES (1, 1, 1)",
      ),
    ).rejects.toThrow();
  });

  test("rebuilding both tables accepts free-text questions and text answers", async () => {
    const db = await seedLegacyDb();

    // The migration's fix: rebuild both constrained tables from the SCHEMA.
    await recreateTable("attendee_answers");
    await recreateTable("questions");

    await db.execute(
      "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text')",
    );
    await db.execute(
      "INSERT INTO strings (text_index, encrypted_text, created) VALUES ('idx', 'enc', '2024-01-01T00:00:00Z')",
    );
    await db.execute(
      "INSERT INTO attendee_answers (attendee_id, question_id, string_id) VALUES (1, 1, 1)",
    );

    const rows = await db.execute(
      "SELECT answer_id, question_id, string_id FROM attendee_answers",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.answer_id).toBe(null);
    expect(rows.rows[0]!.string_id).toBe(1);
  });
});
