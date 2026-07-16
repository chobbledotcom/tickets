import { getDb } from "#shared/db/client.ts";

const OLD_ANSWER_AGGREGATE_TRIGGER_SQL = [
  {
    name: "trg_attendee_answers_aggregates_insert",
    sql: `CREATE TRIGGER trg_attendee_answers_aggregates_insert
   AFTER INSERT ON attendee_answers
   WHEN NEW.answer_id IS NOT NULL
   BEGIN
     UPDATE answers SET times_selected = times_selected + 1
       WHERE id = NEW.answer_id;
   END`,
  },
  {
    name: "trg_attendee_answers_aggregates_delete",
    sql: `CREATE TRIGGER trg_attendee_answers_aggregates_delete
   AFTER DELETE ON attendee_answers
   WHEN OLD.answer_id IS NOT NULL
   BEGIN
     UPDATE answers SET times_selected = times_selected - 1
       WHERE id = OLD.answer_id;
   END`,
  },
  {
    name: "trg_attendee_answers_aggregates_update",
    sql: `CREATE TRIGGER trg_attendee_answers_aggregates_update
   AFTER UPDATE OF answer_id ON attendee_answers
   WHEN OLD.answer_id IS NOT NEW.answer_id
   BEGIN
     UPDATE answers SET times_selected = times_selected - 1
       WHERE id = OLD.answer_id;
     UPDATE answers SET times_selected = times_selected + 1
       WHERE id = NEW.answer_id;
   END`,
  },
] as const;

const OLD_STRING_AGGREGATE_TRIGGER_SQL = [
  `CREATE TRIGGER trg_attendee_answers_strings_insert
   AFTER INSERT ON attendee_answers
   WHEN NEW.string_id IS NOT NULL
   BEGIN
     UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
   END`,
  `CREATE TRIGGER trg_attendee_answers_strings_delete
   AFTER DELETE ON attendee_answers
   WHEN OLD.string_id IS NOT NULL
   BEGIN
     UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
   END`,
  `CREATE TRIGGER trg_attendee_answers_strings_update
   AFTER UPDATE OF string_id ON attendee_answers
   WHEN OLD.string_id IS NOT NEW.string_id
   BEGIN
     UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
     UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
   END`,
] as const;

export const installOldAggregateTriggers = async (): Promise<void> => {
  for (const trigger of OLD_ANSWER_AGGREGATE_TRIGGER_SQL) {
    await getDb().execute(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    await getDb().execute(trigger.sql);
  }
  for (const sql of OLD_STRING_AGGREGATE_TRIGGER_SQL) {
    await getDb().execute(sql);
  }
};
