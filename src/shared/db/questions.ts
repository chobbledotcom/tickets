/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Event-question and attendee-answer mappings use integer foreign keys.
 */

import type { InValue } from "@libsql/client";
import { filter, map, reduce } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  executeBatch,
  inPlaceholders,
  insert,
  queryAll,
} from "#shared/db/client.ts";
import { col, defineTable } from "#shared/db/table.ts";

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
  sort_order: number;
  text: string; // encrypted
}

/** Link between event and question. Membership only — display order comes
 * from the question's own `sort_order`, not from this row. The `sort_order`
 * column is retained but unused (legacy per-event ordering). */
export interface EventQuestion {
  event_id: number;
  id: number;
  question_id: number;
  sort_order: number;
}

/** Link between attendee and selected answer */
export interface AttendeeAnswer {
  answer_id: number;
  attendee_id: number;
  id: number;
}

/** Question with its answer options (decrypted) */
export type QuestionWithAnswers = Question & { answers: Answer[] };

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/** Shared column defs for tables with an encrypted text column */
const generatedId = col.generated<number>();
const encryptedText = col.encrypted<string>(encrypt, decrypt);
const questionIdAndSortOrder = {
  question_id: col.simple<number>(),
  sort_order: col.simple<number>(),
};

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
    ...questionIdAndSortOrder,
    text: encryptedText,
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
    event_id: col.simple<number>(),
    id: col.generated<number>(),
    ...questionIdAndSortOrder,
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
    answer_id: col.simple<number>(),
    attendee_id: col.simple<number>(),
    id: col.generated<number>(),
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
      questionMap.set(row.q_id, { answers: [], text: row.q_text });
    }
    if (row.a_id !== null) {
      questionMap.get(row.q_id)!.answers.push({
        id: row.a_id,
        question_id: row.a_question_id!,
        sort_order: row.a_sort_order!,
        text: row.a_text!,
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
      `SELECT ${QA_COLS} FROM ${QA_JOIN} ORDER BY q.sort_order, q.id, a.sort_order`,
    ),
  );

/** Get questions assigned to an event, in the global question order.
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
       ORDER BY q.sort_order, q.id, a.sort_order`,
        [eventId],
      ),
    ),
  );

/** Get the assigned question IDs for an event, in the global question order. */
export const getEventQuestionIds = async (eventId: number): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      `SELECT eq.question_id
       FROM event_questions eq
       JOIN questions q ON q.id = eq.question_id
       WHERE eq.event_id = ?
       ORDER BY q.sort_order, q.id`,
      [eventId],
    ),
  );

/** Get the IDs of the events a question is assigned to */
export const getQuestionEventIds = async (
  questionId: number,
): Promise<number[]> =>
  map((r: { event_id: number }) => r.event_id)(
    await queryAll<{ event_id: number }>(
      "SELECT event_id FROM event_questions WHERE question_id = ? ORDER BY event_id",
      [questionId],
    ),
  );

/** Set which events a question is assigned to: add it to newly-checked events
 * and remove it from unchecked ones. Membership only — display order is the
 * question's global `sort_order`, so no per-event ordering is written. */
export const setQuestionEvents = async (
  questionId: number,
  eventIds: number[],
): Promise<void> => {
  const current = new Set(await getQuestionEventIds(questionId));
  const target = new Set(eventIds);
  const toRemove = [...current].filter((id) => !target.has(id));
  const toAdd = eventIds.filter((id) => !current.has(id));
  const statements = [
    ...toRemove.map((eventId) => ({
      args: [eventId, questionId],
      sql: "DELETE FROM event_questions WHERE event_id = ? AND question_id = ?",
    })),
    ...toAdd.map((eventId) => ({
      args: [eventId, questionId],
      sql: "INSERT INTO event_questions (event_id, question_id) VALUES (?, ?)",
    })),
  ];
  if (statements.length > 0) await executeBatch(statements);
};

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
  if (eventIds.length === 0) {
    return { questionEventMap: new Map(), questions: [] };
  }

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

  if (rows.length === 0) return { questionEventMap: new Map(), questions: [] };

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
  return { questionEventMap, questions };
};

/** Set which questions are assigned to an event (replaces existing) */
export const setEventQuestions = async (
  eventId: number,
  questionIds: number[],
): Promise<void> => {
  const statements = [
    { args: [eventId], sql: "DELETE FROM event_questions WHERE event_id = ?" },
    ...questionIds.map((qid) =>
      insert("event_questions", {
        event_id: eventId,
        question_id: qid,
      }),
    ),
  ];
  await executeBatch(statements);
};

/** Read and validate one question's submitted answer from form data.
 * `"missing"` = no value; `"invalid"` = the value isn't one of the question's
 * options; otherwise the matched answer id. Shared by the public (required)
 * and admin (optional) answer parsers so the lookup/validation lives once. */
export const readQuestionAnswer = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
):
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; answerId: number } => {
  const raw = form.get(`question_${question.id}`);
  if (!raw) return { status: "missing" };
  const answerId = Number.parseInt(raw, 10);
  if (!question.answers.some((a) => a.id === answerId)) {
    return { status: "invalid" };
  }
  return { answerId, status: "ok" };
};

/** Outcome of parsing a form's submitted answers. */
export type ParsedQuestionAnswers =
  | { ok: true; answerIds: number[] }
  | { ok: false; error: string };

/**
 * Curried answer parser shared by the public and admin flows. The loop and
 * per-answer lookup/validation live here once (over `readQuestionAnswer`);
 * the `optional` flag is the only policy difference between the two callers:
 *
 * - `{ optional: false }` (public booking) — every question must be answered
 *   with a valid option; the first missing/invalid one returns `ok: false`.
 * - `{ optional: true }` (admin edit) — unanswered or invalid questions are
 *   skipped, so the result is always `ok: true` with the valid answers found.
 */
export function parseQuestionAnswers(
  opts: { optional: true },
): (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
) => { ok: true; answerIds: number[] };
export function parseQuestionAnswers(
  opts: { optional: false },
): (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
) => ParsedQuestionAnswers;
export function parseQuestionAnswers(opts: { optional: boolean }) {
  return (
    form: URLSearchParams,
    questions: QuestionWithAnswers[],
  ): ParsedQuestionAnswers => {
    const answerIds: number[] = [];
    for (const q of questions) {
      const answer = readQuestionAnswer(form, q);
      if (answer.status === "ok") {
        answerIds.push(answer.answerId);
        continue;
      }
      if (opts.optional) continue;
      const lead = answer.status === "missing"
        ? "Please answer"
        : "Invalid answer for";
      return { error: `${lead}: ${q.text}`, ok: false };
    }
    return { answerIds, ok: true };
  };
}

/**
 * Replace every listed attendee's answers in one atomic batch: each attendee's
 * existing answers are deleted, then their new answer set inserted. The
 * `Map<attendeeId, answerIds>` is the single shape every save situation reduces
 * to — one answer set shared across attendees, a by-question selection, or the
 * per-event grouping from `groupEventAnswers` — so callers build the map and
 * this builds the SQL. `INSERT OR IGNORE` tolerates an answer set that repeats
 * an id (e.g. an attendee whose booked events share a question), which the
 * unique `(attendee_id, answer_id)` index would otherwise reject.
 */
export const saveAttendeeAnswers = async (
  answersByAttendee: Map<number, number[]>,
): Promise<void> => {
  const statements: { sql: string; args: InValue[] }[] = [];
  for (const [attendeeId, answerIds] of answersByAttendee) {
    statements.push({
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    });
    if (answerIds.length > 0) {
      const placeholders = answerIds.map(() => "(?, ?)").join(", ");
      statements.push({
        args: answerIds.flatMap((id) => [attendeeId, id]),
        sql: `INSERT OR IGNORE INTO attendee_answers (attendee_id, answer_id) VALUES ${placeholders}`,
      });
    }
  }
  if (statements.length > 0) {
    await executeBatch(statements);
  }
};

/**
 * Reduce per-event answer selections to one answer set per attendee. An
 * attendee booking several events in the same submission accumulates every
 * event's answers; events with no answers contribute nothing. Feeds the map
 * straight into `saveAttendeeAnswers`.
 */
export const groupEventAnswers = (
  entries: { attendee: { id: number }; event: { id: number } }[],
  eventAnswerIds: Record<string, number[]>,
): Map<number, number[]> => {
  const answersByAttendee = new Map<number, number[]>();
  for (const { attendee, event } of entries) {
    const answers = eventAnswerIds[String(event.id)];
    if (!answers || answers.length === 0) continue;
    const existing = answersByAttendee.get(attendee.id) ?? [];
    existing.push(...answers);
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
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
    new Map(),
  )(rows);
};

/** Questions across a set of events plus each attendee's selected answers —
 * the shape the attendee table, calendar, groups and edit form all render. */
export type AttendeeQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/**
 * Load the questions for a set of events together with each attendee's chosen
 * answers, in parallel. Returns `undefined` when there's nothing to render —
 * no events, no attendees, or no questions assigned — so callers can skip the
 * answers UI without an extra emptiness check.
 */
export const loadAttendeeQuestionData = async (
  eventIds: number[],
  attendeeIds: number[],
): Promise<AttendeeQuestionData | undefined> => {
  if (attendeeIds.length === 0 || eventIds.length === 0) return undefined;
  const [{ questions }, attendeeAnswerMap] = await Promise.all([
    getQuestionsWithEventIds(eventIds),
    getAttendeeAnswersBatch(attendeeIds),
  ]);
  return questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;
};

/** Get attendee answers mapped by question ID.
 * Returns Map<questionId, { answerId, answerText }> for a single attendee. */
export const getAttendeeAnswersByQuestion = async (
  attendeeId: number,
): Promise<Map<number, { answerId: number; answerText: string }>> => {
  const rows = await queryAll<{
    question_id: number;
    answer_id: number;
    answer_text: string;
  }>(
    `SELECT a.question_id, aa.answer_id, a.text AS answer_text
     FROM attendee_answers aa
     JOIN answers a ON a.id = aa.answer_id
     WHERE aa.attendee_id = ?`,
    [attendeeId],
  );

  const result = new Map<number, { answerId: number; answerText: string }>();
  for (const row of rows) {
    const decrypted = await answersTable.fromDb({
      id: row.answer_id,
      question_id: row.question_id,
      sort_order: 0,
      text: row.answer_text,
    });
    result.set(row.question_id, {
      answerId: row.answer_id,
      answerText: decrypted.text,
    });
  }
  return result;
};

/** Delete a question and all related data in a single batch.
 * Uses a subquery for attendee_answers so the entire cascade is atomic. */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  await executeBatch([
    {
      args: [questionId],
      sql: "DELETE FROM attendee_answers WHERE answer_id IN (SELECT id FROM answers WHERE question_id = ?)",
    },
    { args: [questionId], sql: "DELETE FROM answers WHERE question_id = ?" },
    {
      args: [questionId],
      sql: "DELETE FROM event_questions WHERE question_id = ?",
    },
    { args: [questionId], sql: "DELETE FROM questions WHERE id = ?" },
  ]);
};

/** Delete an answer and all related attendee answers in a single batch */
export const deleteAnswer = async (answerId: number): Promise<void> => {
  await executeBatch([
    {
      args: [answerId],
      sql: "DELETE FROM attendee_answers WHERE answer_id = ?",
    },
    { args: [answerId], sql: "DELETE FROM answers WHERE id = ?" },
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
    new Map(),
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
      args: [sortOrder2, answerId1],
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
    },
    {
      args: [sortOrder1, answerId2],
      sql: "UPDATE answers SET sort_order = ? WHERE id = ?",
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

/** Swap the global sort_order of two questions, reading their current values
 * so callers only need the ids. A no-op visually when both share a value
 * (e.g. legacy rows still at 0 before the id backfill). Callers pass two
 * existing question ids (the move handler takes them from the rendered list). */
export const swapQuestionOrder = async (
  questionId1: number,
  questionId2: number,
): Promise<void> => {
  const rows = await queryAll<{ id: number; sort_order: number }>(
    "SELECT id, sort_order FROM questions WHERE id IN (?, ?)",
    [questionId1, questionId2],
  );
  const orderById = new Map(rows.map((r) => [r.id, r.sort_order]));
  await executeBatch([
    {
      args: [orderById.get(questionId2)!, questionId1],
      sql: "UPDATE questions SET sort_order = ? WHERE id = ?",
    },
    {
      args: [orderById.get(questionId1)!, questionId2],
      sql: "UPDATE questions SET sort_order = ? WHERE id = ?",
    },
  ]);
};

/** Assign a freshly-created question the next global sort_order (max + 1).
 * Always >= 1 so new questions never collide with the one-time id-backfill of
 * legacy rows, which only seeds rows still at sort_order 0. */
export const assignNextQuestionSortOrder = async (
  questionId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [questionId, questionId],
      sql: `UPDATE questions
            SET sort_order = COALESCE(
              (SELECT MAX(sort_order) FROM questions WHERE id != ?), 0
            ) + 1
            WHERE id = ?`,
    },
  ]);
};
