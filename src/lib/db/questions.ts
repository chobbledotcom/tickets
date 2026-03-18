/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Event-question and attendee-answer mappings use integer foreign keys.
 */

import { map, unique } from "#fp";
import { decrypt, encrypt } from "#lib/crypto.ts";
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

/** Get all questions with their answers (sorted by sort_order), decrypted */
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

  // Sort answers by sort_order within each question
  for (const list of answersByQuestion.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order);
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

/** Map from question ID to the set of event IDs that use it */
export type QuestionEventMap = Map<number, number[]>;

/** Build event-ID mapping from event_questions links */
const buildQuestionEventMap = (links: EventQuestion[]): QuestionEventMap => {
  const result: QuestionEventMap = new Map();
  for (const link of links) {
    const existing = result.get(link.question_id);
    if (existing) {
      if (!existing.includes(link.event_id)) existing.push(link.event_id);
    } else {
      result.set(link.question_id, [link.event_id]);
    }
  }
  return result;
};

/** Load event_questions links for multiple events */
const loadEventQuestionLinks = (eventIds: number[]) =>
  queryAll<EventQuestion>(
    `SELECT * FROM event_questions WHERE event_id IN (${inPlaceholders(eventIds)}) ORDER BY sort_order`,
    eventIds,
  );

/** Get questions for multiple events with event-ID mapping (for conditional display) */
export const getQuestionsWithEventIds = async (
  eventIds: number[],
): Promise<{ questions: QuestionWithAnswers[]; questionEventMap: QuestionEventMap }> => {
  if (eventIds.length === 0) return { questions: [], questionEventMap: new Map() };
  const links = await loadEventQuestionLinks(eventIds);
  return {
    questions: await resolveLinkedQuestions(links),
    questionEventMap: buildQuestionEventMap(links),
  };
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

/** Save the same answers for one or more attendees in a single batch */
export const saveAttendeeAnswersBatch = async (
  attendeeIds: number[],
  answerIds: number[],
): Promise<void> => {
  if (attendeeIds.length === 0 || answerIds.length === 0) return;
  await executeBatch(
    attendeeIds.flatMap((attendeeId) =>
      answerIds.map((answerId) => ({
        sql: ATTENDEE_ANSWER_INSERT,
        args: [attendeeId, answerId],
      })),
    ),
  );
};

/** Save attendee answers for a single attendee */
export const saveAttendeeAnswers = (
  attendeeId: number,
  answerIds: number[],
): Promise<void> => saveAttendeeAnswersBatch([attendeeId], answerIds);

/** Get answers for an attendee */
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
    `SELECT * FROM attendee_answers WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
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

/** Delete a question and all related data in a single batch */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  const answers = await queryAll<{ id: number }>(
    "SELECT id FROM answers WHERE question_id = ?",
    [questionId],
  );
  const answerIds = map((a: { id: number }) => a.id)(answers);

  const statements = [
    ...(answerIds.length > 0
      ? [{
          sql: `DELETE FROM attendee_answers WHERE answer_id IN (${inPlaceholders(answerIds)})`,
          args: answerIds,
        }]
      : []),
    { sql: "DELETE FROM answers WHERE question_id = ?", args: [questionId] },
    {
      sql: "DELETE FROM event_questions WHERE question_id = ?",
      args: [questionId],
    },
    { sql: "DELETE FROM questions WHERE id = ?", args: [questionId] },
  ];
  await executeBatch(statements);
};

/** Delete an answer and all related attendee answers in a single batch */
export const deleteAnswer = async (answerId: number): Promise<void> => {
  await executeBatch([
    { sql: "DELETE FROM attendee_answers WHERE answer_id = ?", args: [answerId] },
    { sql: "DELETE FROM answers WHERE id = ?", args: [answerId] },
  ]);
};

/** Get a question by ID (decrypted) */
export const getQuestion = (id: number): Promise<Question | null> =>
  questionsTable.findById(id);

/** Get question with answers by ID */
export const getQuestionWithAnswers = async (
  id: number,
): Promise<QuestionWithAnswers | null> => {
  const question = await questionsTable.findById(id);
  if (!question) return null;

  const answers = await queryAll<Answer>(
    "SELECT * FROM answers WHERE question_id = ? ORDER BY sort_order",
    [id],
  );
  const decryptedAnswers = await Promise.all(
    map((a: Answer) => answersTable.fromDb(a))(answers),
  );

  return { ...question, answers: decryptedAnswers };
};

/** Get the next sort_order for a new answer in a question */
export const getNextAnswerSortOrder = async (
  questionId: number,
): Promise<number> => {
  const rows = await queryAll<{ max_order: number | null }>(
    "SELECT MAX(sort_order) as max_order FROM answers WHERE question_id = ?",
    [questionId],
  );
  return (rows[0]?.max_order ?? -1) + 1;
};
