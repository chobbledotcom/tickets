/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Event-question and attendee-answer mappings use integer foreign keys.
 */

import type { InValue } from "@libsql/client";
import { filter, map, reduce } from "#fp";
import { decrypt, encrypt } from "#lib/crypto/encryption.ts";
import { executeBatch, inPlaceholders, queryAll } from "#lib/db/client.ts";
import { col, defineTable } from "#lib/db/table.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A custom multiple-choice question */
export interface Question {
  id: number;
  text: string; // encrypted
}

/** An answer option for a question */
export interface Answer {
  id: number;
  question_id: number;
  text: string; // encrypted
  sort_order: number;
}

/** Link between event and question (ordering by sort_order) */
export interface EventQuestion {
  id: number;
  event_id: number;
  question_id: number;
  sort_order: number;
}

/** Link between attendee and selected answer */
export interface AttendeeAnswer {
  id: number;
  attendee_id: number;
  answer_id: number;
}

/** Question with its answer options (decrypted) */
export type QuestionWithAnswers = Question & { answers: Answer[] };

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/** Shared column defs for tables with an encrypted text column */
const generatedId = col.generated<number>();
const encryptedText = col.encrypted<string>(encrypt, decrypt);

type QuestionInput = { text: string };

export const questionsTable = defineTable<Question, QuestionInput>({
  name: "questions",
  primaryKey: "id",
  schema: { id: generatedId, text: encryptedText },
});

type AnswerInput = { questionId: number; text: string; sortOrder: number };

export const answersTable = defineTable<Answer, AnswerInput>({
  name: "answers",
  primaryKey: "id",
  schema: {
    id: generatedId,
    question_id: col.simple<number>(),
    text: encryptedText,
    sort_order: col.simple<number>(),
  },
});

type EventQuestionInput = {
  eventId: number;
  questionId: number;
  sortOrder: number;
};

export const eventQuestionsTable = defineTable<
  EventQuestion,
  EventQuestionInput
>({
  name: "event_questions",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    event_id: col.simple<number>(),
    question_id: col.simple<number>(),
    sort_order: col.simple<number>(),
  },
});

type AttendeeAnswerInput = { attendeeId: number; answerId: number };

export const attendeeAnswersTable = defineTable<
  AttendeeAnswer,
  AttendeeAnswerInput
>({
  name: "attendee_answers",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    attendee_id: col.simple<number>(),
    answer_id: col.simple<number>(),
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Flat row from a question ← LEFT JOIN answers query */
type JoinedRow = {
  q_id: number;
  q_text: string;
  a_id: number | null;
  a_text: string | null;
  a_question_id: number | null;
  a_sort_order: number | null;
};

/** Shared SELECT columns and JOIN for question + answers */
const QA_COLS = `q.id AS q_id, q.text AS q_text,
       a.id AS a_id, a.text AS a_text,
       a.question_id AS a_question_id, a.sort_order AS a_sort_order`;
const QA_JOIN = "questions q LEFT JOIN answers a ON a.question_id = q.id";

/** Group flat joined rows into QuestionWithAnswers[], preserving row order.
 * Decrypts question and answer text in parallel. */
const groupJoinedRows = (rows: JoinedRow[]): Promise<QuestionWithAnswers[]> => {
  const questionMap = new Map<number, { text: string; answers: Answer[] }>();
  for (const row of rows) {
    if (!questionMap.has(row.q_id)) {
      questionMap.set(row.q_id, { text: row.q_text, answers: [] });
    }
    if (row.a_id !== null) {
      questionMap.get(row.q_id)!.answers.push({
        id: row.a_id,
        question_id: row.a_question_id!,
        text: row.a_text!,
        sort_order: row.a_sort_order!,
      });
    }
  }

  const entries = [...questionMap.entries()];
  return Promise.all(
    map(
      ([id, { text, answers }]: [
        number,
        { text: string; answers: Answer[] },
      ]) => decryptQuestion(id, text, answers),
    )(entries),
  );
};

/** Keep only questions that have at least one answer */
const withAnswers = filter((q: QuestionWithAnswers) => q.answers.length > 0);

/** Decrypt a single question and its answers */
const decryptQuestion = async (
  id: number,
  rawText: string,
  rawAnswers: Answer[],
): Promise<QuestionWithAnswers> => {
  const [question, ...answers] = await Promise.all([
    questionsTable.fromDb({ id, text: rawText }),
    ...map((a: Answer) => answersTable.fromDb(a))(rawAnswers),
  ]);
  return { ...question, answers };
};

/** Fetch questions with answers by a WHERE clause on q.id */
const fetchQuestions = (where: string, args: InValue[]) =>
  queryAll<JoinedRow>(
    `SELECT ${QA_COLS} FROM ${QA_JOIN} ${where} ORDER BY a.sort_order`,
    args,
  );

/** Get all questions with their answers (sorted by sort_order), decrypted */
export const getAllQuestionsWithAnswers = async (): Promise<
  QuestionWithAnswers[]
> =>
  groupJoinedRows(
    await queryAll<JoinedRow>(
      `SELECT ${QA_COLS} FROM ${QA_JOIN} ORDER BY q.id, a.sort_order`,
    ),
  );

/** Get questions assigned to an event, ordered by sort_order.
 * Questions with no answers are excluded (nothing useful to ask). */
export const getQuestionsForEvent = async (
  eventId: number,
): Promise<QuestionWithAnswers[]> =>
  withAnswers(
    await groupJoinedRows(
      await queryAll<JoinedRow>(
        `SELECT ${QA_COLS}
       FROM event_questions eq
       JOIN questions q ON q.id = eq.question_id
       LEFT JOIN answers a ON a.question_id = q.id
       WHERE eq.event_id = ?
       ORDER BY eq.sort_order, a.sort_order`,
        [eventId],
      ),
    ),
  );

/** Get just the assigned question IDs for an event (no joins/decryption) */
export const getEventQuestionIds = async (eventId: number): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      "SELECT question_id FROM event_questions WHERE event_id = ? ORDER BY sort_order",
      [eventId],
    ),
  );

/** Map from question ID to the set of event IDs that use it */
export type QuestionEventMap = Map<number, number[]>;

/** Joined row including the comma-separated event IDs from GROUP_CONCAT */
type JoinedRowWithEvents = JoinedRow & { event_ids: string };

/** Get questions for multiple events with event-ID mapping (for conditional display).
 * Uses a single query with a subquery filter to avoid row multiplication. */
export const getQuestionsWithEventIds = async (
  eventIds: number[],
): Promise<{
  questions: QuestionWithAnswers[];
  questionEventMap: QuestionEventMap;
}> => {
  if (eventIds.length === 0)
    return { questions: [], questionEventMap: new Map() };

  const ph = inPlaceholders(eventIds);
  const rows = await queryAll<JoinedRowWithEvents>(
    `SELECT ${QA_COLS},
            (SELECT GROUP_CONCAT(eq.event_id) FROM event_questions eq
             WHERE eq.question_id = q.id AND eq.event_id IN (${ph})) AS event_ids
     FROM ${QA_JOIN}
     WHERE q.id IN (SELECT question_id FROM event_questions WHERE event_id IN (${ph}))
     ORDER BY a.sort_order`,
    [...eventIds, ...eventIds],
  );

  if (rows.length === 0) return { questions: [], questionEventMap: new Map() };

  const questionEventMap = reduce(
    (acc: QuestionEventMap, row: JoinedRowWithEvents) => {
      if (!acc.has(row.q_id)) {
        acc.set(row.q_id, map(Number)(row.event_ids.split(",")));
      }
      return acc;
    },
    new Map() as QuestionEventMap,
  )(rows);

  const questions = withAnswers(await groupJoinedRows(rows));
  return { questions, questionEventMap };
};

/** Set which questions are assigned to an event (replaces existing) */
export const setEventQuestions = async (
  eventId: number,
  questionIds: number[],
): Promise<void> => {
  const statements = [
    { sql: "DELETE FROM event_questions WHERE event_id = ?", args: [eventId] },
    ...questionIds.map((qid, i) => ({
      sql: "INSERT INTO event_questions (event_id, question_id, sort_order) VALUES (?, ?, ?)",
      args: [eventId, qid, i],
    })),
  ];
  await executeBatch(statements);
};

const ATTENDEE_ANSWER_INSERT =
  "INSERT INTO attendee_answers (attendee_id, answer_id) VALUES (?, ?)";

/** Replace all answers for one or more attendees in a single atomic batch.
 * Deletes existing answers first, then inserts the new ones. */
export const saveAttendeeAnswers = async (
  attendeeIds: number[],
  answerIds: number[],
): Promise<void> => {
  if (attendeeIds.length === 0) return;
  const deletes = attendeeIds.map((attendeeId) => ({
    sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    args: [attendeeId],
  }));
  const inserts =
    answerIds.length === 0
      ? []
      : attendeeIds.flatMap((attendeeId) =>
          answerIds.map((answerId) => ({
            sql: ATTENDEE_ANSWER_INSERT,
            args: [attendeeId, answerId],
          })),
        );
  await executeBatch([...deletes, ...inserts]);
};

/** Get answers for multiple attendees in a single query */
export const getAttendeeAnswersBatch = async (
  attendeeIds: number[],
): Promise<Map<number, number[]>> => {
  if (attendeeIds.length === 0) return new Map();

  const rows = await queryAll<{ attendee_id: number; answer_id: number }>(
    `SELECT attendee_id, answer_id FROM attendee_answers
     WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    attendeeIds,
  );

  return reduce(
    (
      acc: Map<number, number[]>,
      { attendee_id, answer_id }: { attendee_id: number; answer_id: number },
    ) => {
      const list = acc.get(attendee_id) ?? [];
      list.push(answer_id);
      acc.set(attendee_id, list);
      return acc;
    },
    new Map<number, number[]>(),
  )(rows);
};

/** Delete a question and all related data in a single batch.
 * Uses a subquery for attendee_answers so the entire cascade is atomic. */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  await executeBatch([
    {
      sql: "DELETE FROM attendee_answers WHERE answer_id IN (SELECT id FROM answers WHERE question_id = ?)",
      args: [questionId],
    },
    { sql: "DELETE FROM answers WHERE question_id = ?", args: [questionId] },
    {
      sql: "DELETE FROM event_questions WHERE question_id = ?",
      args: [questionId],
    },
    { sql: "DELETE FROM questions WHERE id = ?", args: [questionId] },
  ]);
};

/** Delete an answer and all related attendee answers in a single batch */
export const deleteAnswer = async (answerId: number): Promise<void> => {
  await executeBatch([
    {
      sql: "DELETE FROM attendee_answers WHERE answer_id = ?",
      args: [answerId],
    },
    { sql: "DELETE FROM answers WHERE id = ?", args: [answerId] },
  ]);
};

/** Get question with answers by ID */
export const getQuestionWithAnswers = async (
  id: number,
): Promise<QuestionWithAnswers | null> => {
  const rows = await fetchQuestions("WHERE q.id = ?", [id]);
  if (rows.length === 0) return null;
  // rows is non-empty so groupJoinedRows always returns at least one entry
  return (await groupJoinedRows(rows))[0]!;
};

/** Get total counts for each answer across all bookings */
export const getAnswerCountsForQuestion = async (
  questionId: number,
): Promise<Map<number, number>> => {
  const rows = await queryAll<{ answer_id: number; cnt: number }>(
    `SELECT a.id AS answer_id, COUNT(aa.id) AS cnt
     FROM answers a
     LEFT JOIN attendee_answers aa ON aa.answer_id = a.id
     WHERE a.question_id = ?
     GROUP BY a.id`,
    [questionId],
  );
  return reduce(
    (
      acc: Map<number, number>,
      { answer_id, cnt }: { answer_id: number; cnt: number },
    ) => {
      acc.set(answer_id, cnt);
      return acc;
    },
    new Map<number, number>(),
  )(rows);
};

/** Swap the sort_order of two answers by their IDs */
export const swapAnswerOrder = async (
  answerId1: number,
  sortOrder1: number,
  answerId2: number,
  sortOrder2: number,
): Promise<void> => {
  await executeBatch([
    {
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
      args: [sortOrder2, answerId1],
    },
    {
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
      args: [sortOrder1, answerId2],
    },
  ]);
};

/** Get the next sort_order for a new answer in a question */
export const getNextAnswerSortOrder = async (
  questionId: number,
): Promise<number> => {
  const [row] = await queryAll<{ next_order: number }>(
    "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM answers WHERE question_id = ?",
    [questionId],
  );
  return row!.next_order;
};
