/**
 * Read queries and listing-assignment mutations for custom questions.
 *
 * Question + answer rows are joined and grouped into {@link QuestionWithAnswers}
 * records, decrypting text in parallel. Listing-question membership is written
 * here too; display order always comes from the question's own sort_order.
 */

import { queryAll, queryAllPrimary } from "#db/client.ts";
import { linkTableSide } from "#db/link-table.ts";
import type { Answer, QuestionWithAnswers } from "#db/question-types.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { readRows } from "#db/read.ts";
import {
  among,
  and,
  type Expr,
  equal,
  inQuery,
  literal,
  notEqual,
  or,
  valued,
} from "#db/select/expression.ts";
import { from, via } from "#db/select/query.ts";
import type { NodeOf } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
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

/** Every question with its answers. A question with no answer stays. */
const questionsWithAnswers = () =>
  from(tables.questions, {
    answer: via(tables.answers, "question").optional(),
  });

type QuestionRead = ReturnType<typeof questionsWithAnswers>;

/** A question and one of its answers, as a read holds them. */
type QuestionNode = NodeOf<QuestionRead>;

/** The order every question list comes back in: the operator's arrangement,
 *  then each question's answers in theirs. */
const inQuestionOrder = (question: QuestionNode) => [
  question.sort_order,
  question.id,
  question.answer.sort_order,
];

/** The columns of a joined row. */
const joinedColumns = (question: QuestionNode) => ({
  a_active: question.answer.active,
  a_id: question.answer.id,
  a_question_id: question.answer.question_id,
  a_sort_order: question.answer.sort_order,
  a_text: question.answer.text,
  q_assign_all: question.assign_all,
  q_display_type: question.display_type,
  q_id: question.id,
  q_text: question.text,
});

/** The question asks every listing. */
const asksEveryListing = (question: QuestionNode): Expr<boolean> =>
  equal(question.assign_all, literal(1));

const joinedRowsOf = (read: QuestionRead) =>
  read.orderBy(inQuestionOrder).select(joinedColumns);

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

/** Fetch questions with their answers, keeping only the ones the read
 * selects. */
const fetchQuestions = (read: QuestionRead = questionsWithAnswers()) =>
  readRows<JoinedRow>(joinedRowsOf(read));

/** Get all questions with their answers (sorted by sort_order), decrypted */
export const getAllQuestionsWithAnswers = async (): Promise<
  QuestionWithAnswers[]
> => groupJoinedRows(await fetchQuestions());

/** Get questions assigned to a listing, in the global question order.
 * Questions with no answers are excluded (nothing useful to ask). */
export const getQuestionsForListing = async (
  listingId: number,
): Promise<QuestionWithAnswers[]> =>
  withAnswers(
    await groupJoinedRows(
      await fetchQuestions(
        questionsWithAnswers()
          .leftJoin("listingQuestion", tables.listing_questions, (question) =>
            and(
              equal(question.listingQuestion.question_id, question.id),
              equal(question.listingQuestion.listing_id, listingId),
            ),
          )
          .where((question) =>
            or(
              asksEveryListing(question),
              notEqual(question.listingQuestion.listing_id, null),
            ),
          ),
      ),
    ),
  );

/** Get the assigned question IDs for a listing, in the global question order. */
export const getListingQuestionIds = async (
  listingId: number,
): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      sql`SELECT question.id AS question_id
       FROM questions AS question
       LEFT JOIN listing_questions AS listingQuestion ON question.id = listingQuestion.question_id AND listingQuestion.listing_id = ${listingId}
       WHERE question.assign_all = 1 OR listingQuestion.listing_id IS NOT NULL
       ORDER BY question.sort_order, question.id`,
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

  const assignments = () =>
    from(tables.listing_questions).where((assigned) =>
      among(assigned.listing_id, listingIds),
    );
  const rows = await queryAll<JoinedRowWithListings>(
    questionsWithAnswers()
      .where((question) =>
        or(
          asksEveryListing(question),
          inQuery(
            question.id,
            assignments().values((assigned) => assigned.question_id),
          ),
        ),
      )
      .orderBy(inQuestionOrder)
      .select((question) => {
        const listings = assignments()
          .where((assigned) => equal(assigned.question_id, question.id))
          .scalar((assigned) =>
            valued<string>(sql`GROUP_CONCAT(${assigned.listing_id})`),
          );
        return {
          ...joinedColumns(question),
          listing_ids: valued<string | null>(
            sql`CASE WHEN ${asksEveryListing(question)} THEN NULL ELSE ${listings} END`,
          ),
        };
      }),
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

/** The joined question rows for one id, on the replica (normal reads) or the
 *  primary (read-your-writes after a write). */
const questionRows = (id: number, primary: boolean) => {
  const read = joinedRowsOf(
    questionsWithAnswers().where((question) => equal(question.id, id)),
  );
  return primary ? queryAllPrimary<JoinedRow>(read) : readRows<JoinedRow>(read);
};

const questionWithAnswers =
  (primary: boolean) =>
  async (id: number): Promise<QuestionWithAnswers | null> => {
    const rows = await questionRows(id, primary);
    if (rows.length === 0) return null;
    // rows is non-empty so groupJoinedRows always returns at least one entry
    return (await groupJoinedRows(rows))[0]!;
  };

/** Get question with answers by ID. A replica can serve it. */
export const getQuestionWithAnswers = questionWithAnswers(false);

/** The same read pinned to the primary. A write sequence that creates a
 *  question and then its first answer cannot miss the row the create just
 *  made. */
export const getQuestionWithAnswersOnPrimary = questionWithAnswers(true);

/** The question a write just made, read from the primary. A write that
 *  committed leaves the row, so a missing row is a broken invariant and throws
 *  instead of answering null. */
export const requireQuestionWithAnswersOnPrimary = async (
  id: number,
): Promise<QuestionWithAnswers> => {
  const question = await getQuestionWithAnswersOnPrimary(id);
  if (question === null) {
    throw new Error(`Question ${id} is missing after its write`);
  }
  return question;
};
