/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Event-question and attendee-answer mappings use integer foreign keys.
 */

import { map, unique } from "#fp";
import { decrypt, encrypt } from "#lib/crypto.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
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

type AnswerInput = { questionId: number; text: string };

export const answersTable = defineTable<Answer, AnswerInput>({
  name: "answers",
  primaryKey: "id",
  schema: {
    id: generatedId,
    question_id: col.simple<number>(),
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

/** Get all questions with their answers, decrypted */
export const getAllQuestionsWithAnswers = async (): Promise<
  QuestionWithAnswers[]
> => {
  const questions = await questionsTable.findAll();
  const answers = await answersTable.findAll();

  const answersByQuestion = new Map<number, Answer[]>();
  for (const a of answers) {
    const list = answersByQuestion.get(a.question_id) ?? [];
    list.push(a);
    answersByQuestion.set(a.question_id, list);
  }

  return map((q: Question) => ({
    ...q,
    answers: answersByQuestion.get(q.id) ?? [],
  }))(questions);
};

/** Resolve event-question links to ordered, deduped QuestionWithAnswers */
const resolveLinkedQuestions = async (
  links: EventQuestion[],
): Promise<QuestionWithAnswers[]> => {
  if (links.length === 0) return [];
  const all = await getAllQuestionsWithAnswers();
  const byId = new Map(
    map((q: QuestionWithAnswers) => [q.id, q] as const)(all),
  );
  const questionIds = unique(map((l: EventQuestion) => l.question_id)(links));
  const result: QuestionWithAnswers[] = [];
  for (const qid of questionIds) {
    const q = byId.get(qid);
    if (q) result.push(q);
  }
  return result;
};

/** Get questions assigned to an event, ordered by sort_order */
export const getQuestionsForEvent = async (
  eventId: number,
): Promise<QuestionWithAnswers[]> => {
  const links = await queryAll<EventQuestion>(
    "SELECT * FROM event_questions WHERE event_id = ? ORDER BY sort_order",
    [eventId],
  );
  return resolveLinkedQuestions(links);
};

/** Get questions for multiple events, deduped and ordered by first appearance */
export const getQuestionsForEvents = async (
  eventIds: number[],
): Promise<QuestionWithAnswers[]> => {
  if (eventIds.length === 0) return [];
  const links = await queryAll<EventQuestion>(
    `SELECT * FROM event_questions WHERE event_id IN (${eventIds.map(() => "?").join(",")}) ORDER BY sort_order`,
    eventIds,
  );
  return resolveLinkedQuestions(links);
};

/** Set which questions are assigned to an event (replaces existing) */
export const setEventQuestions = async (
  eventId: number,
  questionIds: number[],
): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM event_questions WHERE event_id = ?",
    args: [eventId],
  });
  for (let i = 0; i < questionIds.length; i++) {
    await eventQuestionsTable.insert({
      eventId,
      questionId: questionIds[i]!,
      sortOrder: i,
    });
  }
};

/** Save attendee answers (one answer per question) */
export const saveAttendeeAnswers = async (
  attendeeId: number,
  answerIds: number[],
): Promise<void> => {
  for (const answerId of answerIds) {
    await attendeeAnswersTable.insert({ attendeeId, answerId });
  }
};

/** Get answers for an attendee, decrypted */
export const getAttendeeAnswers = (
  attendeeId: number,
): Promise<AttendeeAnswer[]> =>
  queryAll<AttendeeAnswer>(
    "SELECT * FROM attendee_answers WHERE attendee_id = ?",
    [attendeeId],
  );

/** Get answers for multiple attendees in a single query */
export const getAttendeeAnswersBatch = async (
  attendeeIds: number[],
): Promise<Map<number, number[]>> => {
  if (attendeeIds.length === 0) return new Map();

  const rows = await queryAll<AttendeeAnswer>(
    `SELECT * FROM attendee_answers WHERE attendee_id IN (${attendeeIds.map(() => "?").join(",")})`,
    attendeeIds,
  );

  const result = new Map<number, number[]>();
  for (const row of rows) {
    const list = result.get(row.attendee_id) ?? [];
    list.push(row.answer_id);
    result.set(row.attendee_id, list);
  }
  return result;
};

/** Delete a question and all related data (answers, event links, attendee answers) */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  // Get answer IDs first for cascading delete
  const answers = await queryAll<{ id: number }>(
    "SELECT id FROM answers WHERE question_id = ?",
    [questionId],
  );
  const answerIds = map((a: { id: number }) => a.id)(answers);

  if (answerIds.length > 0) {
    await getDb().execute({
      sql: `DELETE FROM attendee_answers WHERE answer_id IN (${answerIds.map(() => "?").join(",")})`,
      args: answerIds,
    });
  }

  await getDb().execute({
    sql: "DELETE FROM answers WHERE question_id = ?",
    args: [questionId],
  });
  await getDb().execute({
    sql: "DELETE FROM event_questions WHERE question_id = ?",
    args: [questionId],
  });
  await getDb().execute({
    sql: "DELETE FROM questions WHERE id = ?",
    args: [questionId],
  });
};

/** Delete an answer and all related attendee answers */
export const deleteAnswer = async (answerId: number): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM attendee_answers WHERE answer_id = ?",
    args: [answerId],
  });
  await getDb().execute({
    sql: "DELETE FROM answers WHERE id = ?",
    args: [answerId],
  });
};

/** Get a question by ID (decrypted) */
export const getQuestion = (id: number): Promise<Question | null> =>
  questionsTable.findById(id);

/** Get an answer by ID (decrypted) */
export const getAnswer = (id: number): Promise<Answer | null> =>
  answersTable.findById(id);

/** Get question with answers by ID */
export const getQuestionWithAnswers = async (
  id: number,
): Promise<QuestionWithAnswers | null> => {
  const question = await questionsTable.findById(id);
  if (!question) return null;

  const answers = await queryAll<Answer>(
    "SELECT * FROM answers WHERE question_id = ?",
    [id],
  );
  const decryptedAnswers = await Promise.all(
    map((a: Answer) => answersTable.fromDb(a))(answers),
  );

  return { ...question, answers: decryptedAnswers };
};
