/**
 * Read queries and listing-assignment mutations for custom questions.
 *
 * Question + answer rows are joined and grouped into {@link QuestionWithAnswers}
 * records, decrypting text in parallel. Listing-question membership is written
 * here too; display order always comes from the question's own sort_order.
 */

import { inPlaceholders, queryAll, type SqlStatement } from "#db/client.ts";
import { linkTableSide } from "#db/link-table.ts";
import type { Answer, QuestionWithAnswers } from "#db/question-types.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { readRows } from "#db/read.ts";
import { equals, type WhereClause } from "#db/where-clauses.ts";
import { filter, map, mapParallel, reduce } from "#fp";

/** Direct question-to-listing assignments, viewed from either side. */
export const questionListings = linkTableSide(
  "listing_questions",
  "question_id",
  "listing_id",
);
export const listingQuestions = linkTableSide(
  "listing_questions",
  "listing_id",
  "question_id",
);

/** Flat row from a question ← LEFT JOIN answers query. `q_assign_all` is the
 * stored form (INTEGER 0/1) — {@link decryptQuestion} turns it into a boolean
 * via the column's read transform. */
type JoinedRow = {
  q_id: number;
  q_assign_all: boolean;
  q_display_type: QuestionWithAnswers["display_type"];
  q_text: string;
  a_id: number | null;
  a_text: string | null;
  a_question_id: number | null;
  a_sort_order: number | null;
  a_active: boolean | null;
};

/** Shared SELECT columns and JOIN for question + answers */
const QA_COLS = `question.id AS q_id, question.assign_all AS q_assign_all, question.display_type AS q_display_type, question.text AS q_text,
       answer.id AS a_id, answer.text AS a_text,
       answer.question_id AS a_question_id, answer.sort_order AS a_sort_order, answer.active AS a_active`;
const QA_JOIN =
  "questions AS question LEFT JOIN answers AS answer ON answer.question_id = question.id";

/** Decrypt a single question and its answers */
const decryptQuestion = async (
  id: number,
  assignAll: boolean,
  displayType: QuestionWithAnswers["display_type"],
  rawText: string,
  rawAnswers: Answer[],
): Promise<QuestionWithAnswers> => {
  const [text, assign_all, answers] = await Promise.all([
    questionsTable.readColumn("text", rawText),
    questionsTable.readColumn("assign_all", assignAll),
    mapParallel((a: Answer) => answersTable.fromDb(a))(rawAnswers),
  ]);
  return {
    answers,
    assign_all,
    display_type: displayType,
    id,
    text,
  };
};

/** Group flat joined rows into QuestionWithAnswers[], preserving row order.
 * Decrypts question and answer text in parallel. The first row of each
 * question group carries the question's fields; every row with an answer id
 * contributes an answer (in row order). */
const groupJoinedRows = (rows: JoinedRow[]): Promise<QuestionWithAnswers[]> =>
  mapParallel(([id, groupRows]: [number, JoinedRow[]]) => {
    const first = groupRows[0]!;
    const answers = groupRows
      .filter((r) => r.a_id !== null)
      .map((r) => ({
        active: r.a_active!,
        id: r.a_id!,
        question_id: r.a_question_id!,
        sort_order: r.a_sort_order!,
        text: r.a_text!,
      }));
    return decryptQuestion(
      id,
      first.q_assign_all,
      first.q_display_type,
      first.q_text,
      answers,
    );
  })([...Map.groupBy(rows, (r) => r.q_id)]);

/** Keep only questions that have at least one answer */
const withAnswers = filter(
  (q: QuestionWithAnswers) =>
    q.display_type === "free_text" || q.answers.length > 0,
);

/** The order every question list comes back in: the operator's arrangement,
 * then each question's answers in theirs. */
const QUESTION_ORDER = "question.sort_order, question.id, answer.sort_order";

/** Fetch questions with their answers, keeping only the ones the clauses
 * select. `from` differs only for the per-listing read, which joins the
 * assignment table to find out which questions a listing asks. */
const fetchQuestions = (
  where: WhereClause[],
  from: string | SqlStatement = QA_JOIN,
) =>
  readRows<JoinedRow>({
    columns: QA_COLS,
    from,
    order: QUESTION_ORDER,
    where,
  });

/** Get all questions with their answers (sorted by sort_order), decrypted */
export const getAllQuestionsWithAnswers = async (): Promise<
  QuestionWithAnswers[]
> => groupJoinedRows(await fetchQuestions([]));

/** Get questions assigned to a listing, in the global question order.
 * Questions with no answers are excluded (nothing useful to ask). */
export const getQuestionsForListing = async (
  listingId: number,
): Promise<QuestionWithAnswers[]> =>
  withAnswers(
    await groupJoinedRows(
      await fetchQuestions(
        [
          {
            args: [],
            clause:
              "question.assign_all = 1 OR listingQuestion.listing_id IS NOT NULL",
          },
        ],
        {
          args: [listingId],
          sql: `questions AS question
       LEFT JOIN listing_questions AS listingQuestion ON question.id = listingQuestion.question_id AND listingQuestion.listing_id = ?
       LEFT JOIN answers AS answer ON answer.question_id = question.id`,
        },
      ),
    ),
  );

/** Get the assigned question IDs for a listing, in the global question order. */
export const getListingQuestionIds = async (
  listingId: number,
): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      `SELECT question.id AS question_id
       FROM questions AS question
       LEFT JOIN listing_questions AS listingQuestion ON question.id = listingQuestion.question_id AND listingQuestion.listing_id = ?
       WHERE question.assign_all = 1 OR listingQuestion.listing_id IS NOT NULL
       ORDER BY question.sort_order, question.id`,
      [listingId],
    ),
  );

/** Map from question ID to the set of listing IDs that use it */
export type QuestionListingMap = Map<number, number[]>;

const emptyQuestionsWithListingIds = (): {
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap;
} => ({ questionListingMap: new Map(), questions: [] });

/** Joined row including the comma-separated listing IDs from GROUP_CONCAT */
type JoinedRowWithListings = JoinedRow & { listing_ids: string | null };

/** Get questions for multiple listings with listing-ID mapping (for conditional display).
 * Uses a single query with a subquery filter to avoid row multiplication. */
export const getQuestionsWithListingIds = async (
  listingIds: number[],
): Promise<{
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap;
}> => {
  if (listingIds.length === 0) return emptyQuestionsWithListingIds();

  const ph = inPlaceholders(listingIds);
  const rows = await queryAll<JoinedRowWithListings>(
    `SELECT ${QA_COLS},
            CASE WHEN question.assign_all = 1 THEN NULL ELSE
              (SELECT GROUP_CONCAT(listingQuestion.listing_id) FROM listing_questions AS listingQuestion
               WHERE listingQuestion.question_id = question.id AND listingQuestion.listing_id IN (${ph}))
            END AS listing_ids
     FROM ${QA_JOIN}
     WHERE question.assign_all = 1 OR question.id IN (SELECT question_id FROM listing_questions WHERE listing_id IN (${ph}))
     ORDER BY question.sort_order, question.id, answer.sort_order`,
    [...listingIds, ...listingIds],
  );

  if (rows.length === 0) return emptyQuestionsWithListingIds();

  const questionListingMap = reduce(
    (acc: QuestionListingMap, row: JoinedRowWithListings) => {
      if (!acc.has(row.q_id) && row.listing_ids !== null) {
        acc.set(row.q_id, map(Number)(row.listing_ids.split(",")));
      }
      return acc;
    },
    new Map() as QuestionListingMap,
  )(rows);

  const questions = withAnswers(await groupJoinedRows(rows));
  return { questionListingMap, questions };
};

/** Get question with answers by ID */
export const getQuestionWithAnswers = async (
  id: number,
): Promise<QuestionWithAnswers | null> => {
  const rows = await fetchQuestions(equals("question.id", id));
  if (rows.length === 0) return null;
  // rows is non-empty so groupJoinedRows always returns at least one entry
  return (await groupJoinedRows(rows))[0]!;
};
