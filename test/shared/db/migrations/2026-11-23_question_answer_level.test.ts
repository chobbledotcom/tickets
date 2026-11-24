import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, executeBatch, getDb } from "#db/client.ts";
import questionAnswerLevel from "#db/migrations/2026-11-23_question_answer_level.ts";
import {
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
} from "#db/migrations/schema-sync.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({
  applySchemaChanges,
  syncIndexes,
  syncTriggers,
});

/** Put the tables back to how a site stood before a question had a level. */
const removeAnswerLevel = (): Promise<unknown> =>
  executeBatch([
    sql`DROP TRIGGER trg_listing_attendees_answers_delete`,
    sql`DROP INDEX idx_attendee_listing_answers_unique`,
    sql`DROP INDEX idx_attendee_answers_booking_row_id`,
    sql`DROP INDEX idx_attendee_string_answers_unique`,
    sql`CREATE UNIQUE INDEX idx_attendee_string_answers_unique
          ON attendee_answers (attendee_id, question_id)`,
    sql`ALTER TABLE attendee_answers DROP COLUMN booking_row_id`,
    sql`ALTER TABLE questions DROP COLUMN answer_level`,
  ]);

const indexSql = async (name: string): Promise<string> => {
  const result = await getDb().execute(
    sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`,
  );
  return String(result.rows[0]?.sql);
};

describeWithEnv("db > migrations > question answer level", { db: true }, () => {
  test("starts every stored question asking once for the booking", async () => {
    await execute(
      sql`INSERT INTO questions (id, text, display_type) VALUES (9201, 'Name?', 'free_text')`,
    );
    await removeAnswerLevel();

    await questionAnswerLevel(context).up();

    const stored = await getDb().execute(
      sql`SELECT answer_level FROM questions WHERE id = 9201`,
    );
    expect({ ...stored.rows[0] }).toEqual({ answer_level: "booking" });
  });

  test("keeps a stored answer for the booking, and refuses a second answer to a question for the booking or for one booking row", async () => {
    await removeAnswerLevel();
    await executeBatch([
      sql`INSERT INTO questions (id, text, display_type) VALUES (9201, 'Name?', 'free_text')`,
      sql`INSERT INTO strings (id, text_index, encrypted_text) VALUES (9401, 'idx', 'enc')`,
      sql`INSERT INTO listing_attendees (id, attendee_id, listing_id) VALUES (9501, 1, 1)`,
      sql`INSERT INTO attendee_answers (attendee_id, question_id, string_id)
            VALUES (1, 9201, 9401)`,
    ]);

    await questionAnswerLevel(context).up();

    const answer = (bookingRow: number | null) =>
      execute(
        sql`INSERT INTO attendee_answers (attendee_id, question_id, string_id, booking_row_id)
              VALUES (1, 9201, 9401, ${bookingRow})`,
      );
    const stored = await getDb().execute(
      sql`SELECT booking_row_id FROM attendee_answers WHERE question_id = 9201`,
    );
    expect(stored.rows.map((row) => ({ ...row }))).toEqual([
      { booking_row_id: null },
    ]);
    await expect(answer(null)).rejects.toThrow("UNIQUE constraint failed");
    await answer(9501);
    await expect(answer(9501)).rejects.toThrow("UNIQUE constraint failed");
  });

  test("indexes only the answers for a booking row, and a row delete finds them by that index", async () => {
    await removeAnswerLevel();

    await questionAnswerLevel(context).up();

    expect(await indexSql("idx_attendee_answers_booking_row_id")).toContain(
      "WHERE booking_row_id IS NOT NULL",
    );
    const plan = await getDb().execute(
      sql`EXPLAIN QUERY PLAN DELETE FROM attendee_answers WHERE booking_row_id = ${1}`,
    );
    expect(plan.rows.map((row) => String(row.detail)).join(" ")).toContain(
      "idx_attendee_answers_booking_row_id",
    );
  });

  test("takes a booking row's answers with the row once the trigger is back", async () => {
    await removeAnswerLevel();

    await questionAnswerLevel(context).up();

    await executeBatch([
      sql`INSERT INTO questions (id, text, display_type, answer_level)
            VALUES (9301, 'Name?', 'free_text', 'listing')`,
      sql`INSERT INTO strings (id, text_index, encrypted_text) VALUES (9401, 'idx', 'enc')`,
      sql`INSERT INTO listing_attendees (id, attendee_id, listing_id) VALUES (9501, 1, 1)`,
      sql`INSERT INTO attendee_answers (attendee_id, question_id, string_id, booking_row_id)
            VALUES (1, 9301, 9401, 9501)`,
      sql`DELETE FROM listing_attendees WHERE id = 9501`,
    ]);
    const left = await getDb().execute(
      sql`SELECT COUNT(*) AS answers FROM attendee_answers WHERE question_id = 9301`,
    );
    expect({ ...left.rows[0] }).toEqual({ answers: 0 });
  });
});
