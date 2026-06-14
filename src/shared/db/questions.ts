/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Listing-question and attendee-answer mappings use integer foreign keys.
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

/** Link between listing and question (ordering by sort_order) */
export interface ListingQuestion {
  listing_id: number;
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

type ListingQuestionInput = {
  listingId: number;
  questionId: number;
  sortOrder: number;
};

export const listingQuestionsTable = defineTable<
  ListingQuestion,
  ListingQuestionInput
>({
  name: "listing_questions",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    listing_id: col.simple<number>(),
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
      `SELECT ${QA_COLS} FROM ${QA_JOIN} ORDER BY q.id, a.sort_order`,
    ),
  );

/** Get questions assigned to an listing, ordered by sort_order.
 * Questions with no answers are excluded (nothing useful to ask). */
export const getQuestionsForListing = async (
  listingId: number,
): Promise<QuestionWithAnswers[]> =>
  withAnswers(
    await groupJoinedRows(
      await queryAll<JoinedRow>(
        `SELECT ${QA_COLS}
       FROM listing_questions eq
       JOIN questions q ON q.id = eq.question_id
       LEFT JOIN answers a ON a.question_id = q.id
       WHERE eq.listing_id = ?
       ORDER BY eq.sort_order, a.sort_order`,
        [listingId],
      ),
    ),
  );

/** Get just the assigned question IDs for an listing (no joins/decryption) */
export const getListingQuestionIds = async (
  listingId: number,
): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      "SELECT question_id FROM listing_questions WHERE listing_id = ? ORDER BY sort_order",
      [listingId],
    ),
  );

/** Get the IDs of the listings a question is assigned to */
export const getQuestionListingIds = async (
  questionId: number,
): Promise<number[]> =>
  map((r: { listing_id: number }) => r.listing_id)(
    await queryAll<{ listing_id: number }>(
      "SELECT listing_id FROM listing_questions WHERE question_id = ? ORDER BY listing_id",
      [questionId],
    ),
  );

/** Set which listings a question is assigned to.
 * Adds the question to newly-checked listings (appended after each listing's
 * existing questions) and removes it from unchecked ones, leaving the
 * ordering of the other questions on each listing untouched. */
export const setQuestionListings = async (
  questionId: number,
  listingIds: number[],
): Promise<void> => {
  const current = new Set(await getQuestionListingIds(questionId));
  const target = new Set(listingIds);
  const toRemove = [...current].filter((id) => !target.has(id));
  const toAdd = listingIds.filter((id) => !current.has(id));
  const statements = [
    ...toRemove.map((listingId) => ({
      args: [listingId, questionId],
      sql: "DELETE FROM listing_questions WHERE listing_id = ? AND question_id = ?",
    })),
    ...toAdd.map((listingId) => ({
      args: [listingId, questionId, listingId],
      sql: `INSERT INTO listing_questions (listing_id, question_id, sort_order)
            VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM listing_questions WHERE listing_id = ?), 0))`,
    })),
  ];
  if (statements.length > 0) await executeBatch(statements);
};

/** Map from question ID to the set of listing IDs that use it */
export type QuestionListingMap = Map<number, number[]>;

/** Joined row including the comma-separated listing IDs from GROUP_CONCAT */
type JoinedRowWithListings = JoinedRow & { listing_ids: string };

/** Get questions for multiple listings with listing-ID mapping (for conditional display).
 * Uses a single query with a subquery filter to avoid row multiplication. */
export const getQuestionsWithListingIds = async (
  listingIds: number[],
): Promise<{
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap;
}> => {
  if (listingIds.length === 0) {
    return { questionListingMap: new Map(), questions: [] };
  }

  const ph = inPlaceholders(listingIds);
  const rows = await queryAll<JoinedRowWithListings>(
    `SELECT ${QA_COLS},
            (SELECT GROUP_CONCAT(eq.listing_id) FROM listing_questions eq
             WHERE eq.question_id = q.id AND eq.listing_id IN (${ph})) AS listing_ids
     FROM ${QA_JOIN}
     WHERE q.id IN (SELECT question_id FROM listing_questions WHERE listing_id IN (${ph}))
     ORDER BY a.sort_order`,
    [...listingIds, ...listingIds],
  );

  if (rows.length === 0)
    return { questionListingMap: new Map(), questions: [] };

  const questionListingMap = reduce(
    (acc: QuestionListingMap, row: JoinedRowWithListings) => {
      if (!acc.has(row.q_id)) {
        acc.set(row.q_id, map(Number)(row.listing_ids.split(",")));
      }
      return acc;
    },
    new Map() as QuestionListingMap,
  )(rows);

  const questions = withAnswers(await groupJoinedRows(rows));
  return { questionListingMap, questions };
};

/** Set which questions are assigned to an listing (replaces existing) */
export const setListingQuestions = async (
  listingId: number,
  questionIds: number[],
): Promise<void> => {
  const statements = [
    {
      args: [listingId],
      sql: "DELETE FROM listing_questions WHERE listing_id = ?",
    },
    ...questionIds.map((qid, i) =>
      insert("listing_questions", {
        listing_id: listingId,
        question_id: qid,
        sort_order: i,
      }),
    ),
  ];
  await executeBatch(statements);
};

const answerInsert = (attendeeId: number, answerId: number) =>
  insert("attendee_answers", {
    answer_id: answerId,
    attendee_id: attendeeId,
  });

/** Replace all answers for one or more attendees in a single atomic batch.
 * Deletes existing answers first, then inserts the new ones. */
export const saveAttendeeAnswers = async (
  attendeeIds: number[],
  answerIds: number[],
): Promise<void> => {
  if (attendeeIds.length === 0) return;
  const deletes = attendeeIds.map((attendeeId) => ({
    args: [attendeeId],
    sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
  }));
  const inserts =
    answerIds.length === 0
      ? []
      : attendeeIds.flatMap((attendeeId) =>
          answerIds.map((answerId) => answerInsert(attendeeId, answerId)),
        );
  await executeBatch([...deletes, ...inserts]);
};

/**
 * Save per-listing question answers for a batch of attendee/listing pairs.
 * Collects all deletes and inserts into a single executeBatch call.
 */
export const saveListingAnswers = async (
  entries: { attendee: { id: number }; listing: { id: number } }[],
  listingAnswerIds: Record<string, number[]>,
): Promise<void> => {
  // Collect all answer IDs per attendee (one attendee may span multiple listings)
  const answersByAttendee = new Map<number, number[]>();
  for (const { attendee, listing } of entries) {
    const answers = listingAnswerIds[String(listing.id)];
    if (answers && answers.length > 0) {
      const existing = answersByAttendee.get(attendee.id) ?? [];
      existing.push(...answers);
      answersByAttendee.set(attendee.id, existing);
    }
  }

  const statements: { sql: string; args: InValue[] }[] = [];
  for (const [attendeeId, answers] of answersByAttendee) {
    statements.push({
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    });
    const placeholders = answers.map(() => "(?, ?)").join(", ");
    const args = answers.flatMap((id) => [attendeeId, id]);
    statements.push({
      args,
      sql: `INSERT OR IGNORE INTO attendee_answers (attendee_id, answer_id) VALUES ${placeholders}`,
    });
  }
  if (statements.length > 0) {
    await executeBatch(statements);
  }
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

/** Save attendee answers by question ID mapping.
 * Replaces all answers for the given attendee. */
export const saveAttendeeAnswersByQuestion = async (
  attendeeId: number,
  questionToAnswer: Map<number, number>,
): Promise<void> => {
  const statements: { sql: string; args: InValue[] }[] = [
    {
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    },
    ...Array.from(questionToAnswer.values()).map((answerId) =>
      answerInsert(attendeeId, answerId),
    ),
  ];
  await executeBatch(statements);
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
      sql: "DELETE FROM listing_questions WHERE question_id = ?",
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
