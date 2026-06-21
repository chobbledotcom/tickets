/**
 * Custom questions and answers table operations
 *
 * Questions and answers are encrypted at rest using symmetric encryption (DB_ENCRYPTION_KEY).
 * Listing-question and attendee-answer mappings use integer foreign keys.
 */

import type { InValue } from "@libsql/client";
import { filter, map, reduce } from "#fp";
/* jscpd:ignore-start */
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import {
  execute,
  executeBatch,
  executeBatchWithResults,
  inPlaceholders,
  insert,
  queryAll,
  queryOne,
  resetAggregates,
  resultRows,
} from "#shared/db/client.ts";
/* jscpd:ignore-end */
import { columnMapByIds, swapSortOrder } from "#shared/db/query.ts";
import { settings } from "#shared/db/settings.ts";
import { col, defineTable } from "#shared/db/table.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A custom multiple-choice question */
export const QUESTION_DISPLAY_TYPES = ["radio", "select", "free_text"] as const;
export type QuestionDisplayType = (typeof QUESTION_DISPLAY_TYPES)[number];

export const isQuestionDisplayType = (
  value: string,
): value is QuestionDisplayType =>
  QUESTION_DISPLAY_TYPES.includes(value as QuestionDisplayType);

export const questionDisplayTypeError =
  "Display as must be radio buttons, a select box, or free text";

export const requireQuestionDisplayType = (
  value: string,
): QuestionDisplayType => {
  if (isQuestionDisplayType(value)) return value;
  throw new Error(questionDisplayTypeError);
};

export interface Question {
  assign_all: boolean;
  display_type: QuestionDisplayType;
  id: number;
  text: string; // encrypted
}

/** An answer option for a question */
export interface Answer {
  id: number;
  question_id: number;
  sort_order: number;
  text: string; // encrypted
  /** Deactivated answers are hidden on the public booking form; the admin edit
   * form still shows one an attendee already selected so it isn't silently
   * dropped on the next save. */
  active: boolean;
}

/** Link between listing and question. Membership only — display order comes
 * from the question's own `sort_order`, not from this row. The `sort_order`
 * column is retained but unused (legacy per-listing ordering). */
export interface ListingQuestion {
  listing_id: number;
  id: number;
  question_id: number;
  sort_order: number;
}

/** Question with its answer options (decrypted) */
export type QuestionWithAnswers = Omit<Question, "assign_all"> & {
  answers: Answer[];
  assign_all?: boolean;
};

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

type QuestionInput = {
  assignAll?: boolean;
  displayType: QuestionDisplayType;
  text: string;
};

export const questionsTable = defineTable<Question, QuestionInput>({
  name: "questions",
  primaryKey: "id",
  schema: {
    assign_all: col.boolean(false),
    display_type: col.simple<QuestionDisplayType>(),
    id: generatedId,
    text: encryptedText,
  },
});

type AnswerInput = {
  questionId: number;
  text: string;
  sortOrder: number;
  active?: boolean;
};

export const answersTable = defineTable<Answer, AnswerInput>({
  name: "answers",
  primaryKey: "id",
  schema: {
    active: col.boolean(true),
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

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Flat row from a question ← LEFT JOIN answers query */
type JoinedRow = {
  q_id: number;
  q_assign_all: boolean;
  q_display_type: QuestionDisplayType;
  q_text: string;
  a_id: number | null;
  a_text: string | null;
  a_question_id: number | null;
  a_sort_order: number | null;
  a_active: boolean | null;
};

/** Shared SELECT columns and JOIN for question + answers */
const QA_COLS = `q.id AS q_id, q.assign_all AS q_assign_all, q.display_type AS q_display_type, q.text AS q_text,
       a.id AS a_id, a.text AS a_text,
       a.question_id AS a_question_id, a.sort_order AS a_sort_order, a.active AS a_active`;
const QA_JOIN = "questions q LEFT JOIN answers a ON a.question_id = q.id";

/** Group flat joined rows into QuestionWithAnswers[], preserving row order.
 * Decrypts question and answer text in parallel. */
const groupJoinedRows = (rows: JoinedRow[]): Promise<QuestionWithAnswers[]> => {
  type Group = {
    assignAll: boolean;
    displayType: QuestionDisplayType;
    text: string;
    answers: Answer[];
  };
  const questionMap = reduce((acc: Map<number, Group>, row: JoinedRow) => {
    const group = acc.get(row.q_id) ?? {
      answers: [],
      assignAll: row.q_assign_all,
      displayType: row.q_display_type,
      text: row.q_text,
    };
    if (row.a_id !== null) {
      group.answers.push({
        active: row.a_active!,
        id: row.a_id,
        question_id: row.a_question_id!,
        sort_order: row.a_sort_order!,
        text: row.a_text!,
      });
    }
    return acc.set(row.q_id, group);
  }, new Map<number, Group>())(rows);

  const entries = [...questionMap.entries()];
  return Promise.all(
    map(
      ([id, { assignAll, displayType, text, answers }]: [
        number,
        {
          assignAll: boolean;
          displayType: QuestionDisplayType;
          text: string;
          answers: Answer[];
        },
      ]) => decryptQuestion(id, assignAll, displayType, text, answers),
    )(entries),
  );
};

/** Keep only questions that have at least one answer */
const withAnswers = filter(
  (q: QuestionWithAnswers) =>
    q.display_type === "free_text" || q.answers.length > 0,
);

/** Decrypt a single question and its answers */
const decryptQuestion = async (
  id: number,
  assignAll: boolean,
  displayType: QuestionDisplayType,
  rawText: string,
  rawAnswers: Answer[],
): Promise<QuestionWithAnswers> => {
  const [question, ...answers] = await Promise.all([
    questionsTable.fromDb({
      assign_all: assignAll,
      display_type: displayType,
      id,
      text: rawText,
    }),
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

/** Get questions assigned to a listing, in the global question order.
 * Questions with no answers are excluded (nothing useful to ask). */
export const getQuestionsForListing = async (
  listingId: number,
): Promise<QuestionWithAnswers[]> =>
  withAnswers(
    await groupJoinedRows(
      await queryAll<JoinedRow>(
        `SELECT ${QA_COLS}
       FROM questions q
       LEFT JOIN listing_questions eq ON q.id = eq.question_id AND eq.listing_id = ?
       LEFT JOIN answers a ON a.question_id = q.id
       WHERE q.assign_all = 1 OR eq.listing_id IS NOT NULL
       ORDER BY q.sort_order, q.id, a.sort_order`,
        [listingId],
      ),
    ),
  );

/** Get the assigned question IDs for a listing, in the global question order. */
export const getListingQuestionIds = async (
  listingId: number,
): Promise<number[]> =>
  map((r: { question_id: number }) => r.question_id)(
    await queryAll<{ question_id: number }>(
      `SELECT q.id AS question_id
       FROM questions q
       LEFT JOIN listing_questions eq ON q.id = eq.question_id AND eq.listing_id = ?
       WHERE q.assign_all = 1 OR eq.listing_id IS NOT NULL
       ORDER BY q.sort_order, q.id`,
      [listingId],
    ),
  );

/** Map from question id to the ids of the listings it is directly assigned to,
 * for the questions list table's Listings column. Assign-all questions are
 * omitted (the caller renders "All" for them). The caller resolves ids to
 * (decrypted) names from its already-loaded listing list. */
export const getAllQuestionListingIds = async (): Promise<
  Map<number, number[]>
> => {
  const rows = await queryAll<{ question_id: number; listing_id: number }>(
    `SELECT question_id, listing_id FROM listing_questions
     ORDER BY question_id, listing_id`,
  );
  return reduce(
    (
      acc: Map<number, number[]>,
      row: { question_id: number; listing_id: number },
    ) => {
      const ids = acc.get(row.question_id) ?? [];
      ids.push(row.listing_id);
      return acc.set(row.question_id, ids);
    },
    new Map<number, number[]>(),
  )(rows);
};

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

/** Set which listings a question is assigned to: add it to newly-checked
 * listings and remove it from unchecked ones. Membership only — display order
 * is the question's global `sort_order`, so no per-listing ordering is written. */
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
      args: [listingId, questionId],
      sql: "INSERT INTO listing_questions (listing_id, question_id) VALUES (?, ?)",
    })),
  ];
  if (statements.length > 0) await executeBatch(statements);
};

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
            CASE WHEN q.assign_all = 1 THEN NULL ELSE
              (SELECT GROUP_CONCAT(eq.listing_id) FROM listing_questions eq
               WHERE eq.question_id = q.id AND eq.listing_id IN (${ph}))
            END AS listing_ids
     FROM ${QA_JOIN}
     WHERE q.assign_all = 1 OR q.id IN (SELECT question_id FROM listing_questions WHERE listing_id IN (${ph}))
     ORDER BY q.sort_order, q.id, a.sort_order`,
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
    ...questionIds.map((qid) =>
      insert("listing_questions", {
        listing_id: listingId,
        question_id: qid,
      }),
    ),
  ];
  await executeBatch(statements);
};

/** Read and validate one question's submitted answer from form data.
 * `"missing"` = no value; `"invalid"` = the value isn't one of the question's
 * options (or, when `activeOnly`, is a deactivated option); otherwise the
 * matched answer id. Shared by the public (required, active-only) and admin
 * (optional, allows a pre-selected deactivated answer) parsers. */
export const readQuestionAnswer = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
  activeOnly = false,
):
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; answerId: number } => {
  const raw = form.get(`question_${question.id}`);
  if (!raw) return { status: "missing" };
  const answerId = Number.parseInt(raw, 10);
  const answer = question.answers.find((a) => a.id === answerId);
  if (!answer || (activeOnly && !answer.active)) {
    return { status: "invalid" };
  }
  return { answerId, status: "ok" };
};

/** Outcome of parsing a form's submitted answers. */
export type TextAnswer = { questionId: number; text: string };
export type TextAnswerId = { questionId: number; stringId: number };
export type ParsedQuestionAnswers =
  | { ok: true; answerIds: number[]; textAnswers: TextAnswer[] }
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
type MutableParsedQuestionAnswers = {
  answerIds: number[];
  textAnswers: TextAnswer[];
};

/** Validate one question's submitted answer, recording any valid answer into
 * `parsed` and returning an error message (or null when valid, or skippable
 * because `optional`). */
type AnswerParser = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
  parsed: MutableParsedQuestionAnswers,
  optional: boolean,
) => string | null;

const parseFreeTextAnswer: AnswerParser = (
  form,
  question,
  parsed,
  optional,
) => {
  const text = (form.get(`question_${question.id}`) ?? "").trim();
  // Cap free-text length so an unauthenticated booking cannot submit an
  // arbitrarily large value (expensive to encrypt, large blob to retain). The
  // public input mirrors this with a maxlength; optional (admin) parsing skips
  // an over-long value rather than erroring, keeping its always-ok contract.
  if (text.length > MAX_TEXTAREA_LENGTH) {
    return optional ? null : `Answer is too long: ${question.text}`;
  }
  if (text) {
    parsed.textAnswers.push({ questionId: question.id, text });
    return null;
  }
  return optional ? null : `Please answer: ${question.text}`;
};

const parseChoiceAnswer: AnswerParser = (form, question, parsed, optional) => {
  // Public submissions may only pick an active answer; the admin edit form may
  // re-save a deactivated answer the attendee had already chosen.
  const answer = readQuestionAnswer(form, question, !optional);
  if (answer.status === "ok") {
    parsed.answerIds.push(answer.answerId);
    return null;
  }
  if (optional) return null;
  // A choice question with no active answers has nothing selectable (it is
  // hidden on the form), so it can't block the booking.
  if (!question.answers.some((a) => a.active)) return null;
  const lead =
    answer.status === "missing" ? "Please answer" : "Invalid answer for";
  return `${lead}: ${question.text}`;
};

const parseQuestionAnswer: AnswerParser = (form, question, parsed, optional) =>
  question.display_type === "free_text"
    ? parseFreeTextAnswer(form, question, parsed, optional)
    : parseChoiceAnswer(form, question, parsed, optional);

export function parseQuestionAnswers(opts: {
  optional: true;
}): (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
) => { ok: true; answerIds: number[]; textAnswers: TextAnswer[] };
export function parseQuestionAnswers(opts: {
  optional: false;
}): (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
) => ParsedQuestionAnswers;
export function parseQuestionAnswers(opts: { optional: boolean }) {
  return (
    form: URLSearchParams,
    questions: QuestionWithAnswers[],
  ): ParsedQuestionAnswers => {
    const parsed: MutableParsedQuestionAnswers = {
      answerIds: [],
      textAnswers: [],
    };
    for (const question of questions) {
      const error = parseQuestionAnswer(form, question, parsed, opts.optional);
      if (error) return { error, ok: false };
    }
    return { ok: true, ...parsed };
  };
}

/**
 * Pair each just-written string (`text` + its `textIndex`) with the id the
 * post-insert SELECT returned, keyed by text.
 *
 * Throws if any `textIndex` is missing from `found`. In `getOrCreateStringIds`
 * the read runs in the same write-mode batch as the insert (one primary
 * transaction), so every index we wrote must come back; a miss means that
 * read-your-writes invariant broke. Returning an `undefined` id instead would
 * corrupt every caller silently — a checkout would drop the `s` from its signed
 * metadata and the webhook would later bind `undefined` into SQL ("Unsupported
 * type of value"). Failing loudly here keeps the corruption from escaping.
 */
export const pairStringIds = (
  rows: readonly { text: string; textIndex: string }[],
  found: readonly { id: number; text_index: string }[],
): Map<string, number> => {
  const idByIndex = new Map(found.map((row) => [row.text_index, row.id]));
  return new Map(
    rows.map((row) => {
      const id = idByIndex.get(row.textIndex);
      if (id === undefined) {
        throw new Error(
          `String id missing immediately after insert (text_index=${row.textIndex})`,
        );
      }
      return [row.text, id];
    }),
  );
};

export const getOrCreateStringIds = async (
  texts: string[],
): Promise<Map<string, number>> => {
  if (texts.length === 0) return new Map();
  const uniqueTexts = [...new Set(texts)];
  const rows = await Promise.all(
    uniqueTexts.map(async (text) => ({
      encrypted: await encryptWithOwnerKey(text, settings.publicKey),
      text,
      textIndex: await hmacHash(text),
    })),
  );
  const created = nowIso();
  const textIndexes = rows.map((r) => r.textIndex);
  // Insert, refresh `created`, and read the ids back in ONE write-mode batch.
  // A write batch is a single transaction forwarded to the primary, so the
  // trailing SELECT reads its own just-inserted rows. Reading the ids with a
  // separate query would be a plain read the platform may serve from a replica
  // that has not yet replicated the insert — for a brand-new string it returns
  // no row, the id resolves to undefined, and the value is silently lost.
  const results = await executeBatchWithResults([
    ...rows.map((row) => ({
      args: [row.textIndex, row.encrypted, created],
      sql: "INSERT OR IGNORE INTO strings (text_index, encrypted_text, created) VALUES (?, ?, ?)",
    })),
    // Refresh `created` on every referenced row. INSERT OR IGNORE leaves an
    // existing row's timestamp untouched, so without this the age-based prune
    // could delete a row a checkout still references in its signed metadata
    // (the trigger no longer deletes on used_count = 0, so the pruner is the
    // only thing that removes strings). Refreshing a row that is reused now —
    // even one currently attached to another attendee — keeps it alive past
    // that other attendee later freeing it, until this checkout finalizes.
    {
      args: [created, ...textIndexes],
      sql: `UPDATE strings SET created = ? WHERE text_index IN (${inPlaceholders(textIndexes)})`,
    },
    {
      args: textIndexes,
      sql: `SELECT id, text_index FROM strings WHERE text_index IN (${inPlaceholders(textIndexes)})`,
    },
  ]);
  const found = resultRows<{ id: number; text_index: string }>(results.at(-1)!);
  return pairStringIds(rows, found);
};

export type AttendeeAnswerSet = {
  answerIds: number[];
  textAnswerIds?: TextAnswerId[];
  textAnswers?: TextAnswer[];
};

const normalizeAnswerSet = (
  answerIdsOrSet: number[] | AttendeeAnswerSet,
): AttendeeAnswerSet =>
  Array.isArray(answerIdsOrSet)
    ? { answerIds: answerIdsOrSet }
    : answerIdsOrSet;

const questionIdsByAnswerId = (
  answerIds: number[],
): Promise<Map<number, number>> =>
  columnMapByIds("answers", "answer", "question_id", answerIds);

const dedupeByQuestion = <T extends { questionId: number }>(
  answers: T[],
): T[] => {
  const answerByQuestion = new Map<number, T>();
  for (const answer of answers) {
    answerByQuestion.set(answer.questionId, answer);
  }
  return [...answerByQuestion.values()];
};

const dedupeAnswerIdsByQuestion = (
  answerIds: number[],
  questionIdsByAnswer: Map<number, number>,
): number[] => {
  const answerIdByQuestion = new Map<number, number>();
  for (const answerId of answerIds) {
    const questionId = questionIdsByAnswer.get(answerId);
    // The answer may have been deleted between checkout and finalize (e.g. the
    // owner removed it while the buyer was at the payment provider). Skip it:
    // there is no question to attach it to, and throwing here would repeatedly
    // break the finalize of an already-captured payment.
    if (questionId === undefined) continue;
    answerIdByQuestion.set(questionId, answerId);
  }
  return [...answerIdByQuestion.values()];
};

const dedupeTextAnswerIdsByQuestion = (
  textAnswerIds: TextAnswerId[],
): TextAnswerId[] => dedupeByQuestion(textAnswerIds);

/** The subset of `questionIds` that still exist — text answers reference a
 * question directly, so a question deleted between checkout and finalize must
 * be dropped (mirrors the deleted-answer skip on the choice path) rather than
 * inserting an orphan row whose plaintext the admin UI can never surface. */
const existingQuestionIds = async (
  questionIds: number[],
): Promise<Set<number>> => {
  if (questionIds.length === 0) return new Set();
  const rows = await queryAll<{ id: number }>(
    `SELECT id FROM questions WHERE id IN (${inPlaceholders(questionIds)})`,
    questionIds,
  );
  return new Set(rows.map((row) => row.id));
};

/**
 * Replace every listed attendee's answers in one atomic batch: each attendee's
 * existing answers are deleted, then their new answer set inserted. The
 * `Map<attendeeId, answerIds>` is the single shape every save situation reduces
 * to — one answer set shared across attendees, a by-question selection, or the
 * per-listing grouping from `groupListingAnswers` — so callers build the map and
 * this builds the SQL. Repeated question answers collapse to the last value
 * before insert, matching the single-answer-per-question invariant.
 */
export const saveAttendeeAnswers = async (
  answersByAttendee: Map<number, number[] | AttendeeAnswerSet>,
): Promise<void> => {
  const normalized = new Map<
    number,
    AttendeeAnswerSet & {
      textAnswerIds: TextAnswerId[];
      textAnswers: TextAnswer[];
    }
  >(
    [...answersByAttendee].map(([id, set]) => {
      const answerSet = normalizeAnswerSet(set);
      return [
        id,
        {
          ...answerSet,
          textAnswerIds: dedupeByQuestion(answerSet.textAnswerIds ?? []),
          textAnswers: dedupeByQuestion(answerSet.textAnswers ?? []),
        },
      ];
    }),
  );
  if (normalized.size === 0) return;
  // Clear each attendee's existing answers FIRST, in its own committed batch.
  // The delete fires the string-refcount trigger, which drops any free-text
  // string this attendee was the last user of — so it has to run before we
  // resolve/create the strings we re-insert. Resolving first (the old order)
  // meant a re-saved unchanged answer pointed at a string the delete then
  // dropped, silently losing the value. getOrCreateStringIds below re-creates
  // any string the delete removed.
  await executeBatch(
    [...normalized.keys()].map((attendeeId) => ({
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    })),
  );
  const [stringIds, questionIdsByAnswer, liveTextQuestionIds] =
    await Promise.all([
      getOrCreateStringIds(
        [...normalized.values()].flatMap((set) =>
          set.textAnswers.map((a) => a.text),
        ),
      ),
      questionIdsByAnswerId([
        ...new Set([...normalized.values()].flatMap((set) => set.answerIds)),
      ]),
      existingQuestionIds([
        ...new Set(
          [...normalized.values()].flatMap((set) => [
            ...set.textAnswerIds.map((answer) => answer.questionId),
            ...set.textAnswers.map((answer) => answer.questionId),
          ]),
        ),
      ]),
    ]);
  const statements: { sql: string; args: InValue[] }[] = [];
  for (const [
    attendeeId,
    { answerIds, textAnswerIds, textAnswers },
  ] of normalized) {
    const dedupedAnswerIds = dedupeAnswerIdsByQuestion(
      answerIds,
      questionIdsByAnswer,
    );
    if (dedupedAnswerIds.length > 0) {
      const placeholders = dedupedAnswerIds.map(() => "(?, ?, ?)").join(", ");
      statements.push({
        args: dedupedAnswerIds.flatMap((id) => [
          attendeeId,
          questionIdsByAnswer.get(id)!,
          id,
        ]),
        sql: `INSERT INTO attendee_answers (attendee_id, question_id, answer_id) VALUES ${placeholders}`,
      });
    }
    const resolvedTextAnswerIds = dedupeTextAnswerIdsByQuestion([
      ...textAnswerIds,
      ...textAnswers.map((answer) => ({
        questionId: answer.questionId,
        stringId: stringIds.get(answer.text)!,
      })),
    ]).filter((answer) => liveTextQuestionIds.has(answer.questionId));
    if (resolvedTextAnswerIds.length > 0) {
      const placeholders = resolvedTextAnswerIds
        .map(() => "(?, ?, ?)")
        .join(", ");
      statements.push({
        args: resolvedTextAnswerIds.flatMap((answer) => [
          attendeeId,
          answer.questionId,
          answer.stringId,
        ]),
        sql: `INSERT INTO attendee_answers (attendee_id, question_id, string_id) VALUES ${placeholders}`,
      });
    }
  }
  if (statements.length > 0) {
    await executeBatch(statements);
  }
};

/** One booked line: an attendee paired with one listing they are booked into.
 * The per-listing answer maps are keyed by `String(listing.id)`. */
export type AttendeeListingEntry = {
  attendee: { id: number };
  listing: { id: number };
};

/**
 * Reduce per-listing answer selections to one answer set per attendee. An
 * attendee booking several listings in the same submission accumulates every
 * listing's answers; listings with no answers contribute nothing. Feeds the map
 * straight into `saveAttendeeAnswers`.
 */
export const groupListingAnswers = (
  entries: AttendeeListingEntry[],
  listingAnswerIds: Record<string, number[]>,
): Map<number, number[]> => {
  const answersByAttendee = new Map<number, number[]>();
  for (const { attendee, listing } of entries) {
    const answers = listingAnswerIds[String(listing.id)];
    if (!answers || answers.length === 0) continue;
    const existing = answersByAttendee.get(attendee.id) ?? [];
    existing.push(...answers);
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
};

const choiceAnswerIdsBatch = async (
  attendeeIds: number[],
): Promise<Map<number, number[]>> => {
  if (attendeeIds.length === 0) return new Map();
  const rows = await queryAll<{ attendee_id: number; answer_id: number }>(
    `SELECT attendee_id, answer_id FROM attendee_answers
     WHERE answer_id IS NOT NULL AND attendee_id IN (${inPlaceholders(attendeeIds)})`,
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

/** Decrypted free-text answers for several attendees: attendeeId → (questionId
 * → text). Needs the owner private key, so callers must opt in deliberately. */
export const getAttendeeTextAnswersBatch = async (
  attendeeIds: number[],
  privateKey: CryptoKey,
): Promise<Map<number, Map<number, string>>> => {
  if (attendeeIds.length === 0) return new Map();
  const rows = await queryAll<{
    attendee_id: number;
    question_id: number;
    encrypted_text: string;
  }>(
    `SELECT attendee_answer.attendee_id, attendee_answer.question_id,
            string.encrypted_text
     FROM attendee_answers AS attendee_answer
     JOIN strings AS string ON string.id = attendee_answer.string_id
     WHERE attendee_answer.question_id IS NOT NULL
       AND attendee_answer.attendee_id IN (${inPlaceholders(attendeeIds)})`,
    attendeeIds,
  );
  const decrypted = await Promise.all(
    rows.map(async (row) => ({
      attendeeId: row.attendee_id,
      questionId: row.question_id,
      text: await decryptWithOwnerKey(row.encrypted_text, privateKey),
    })),
  );
  const result = new Map<number, Map<number, string>>();
  for (const { attendeeId, questionId, text } of decrypted) {
    const inner = result.get(attendeeId) ?? new Map<number, string>();
    inner.set(questionId, text);
    result.set(attendeeId, inner);
  }
  return result;
};

/** Choice answer ids plus, when requested, decrypted free-text answers. */
export type AttendeeAnswersBatch = {
  answerIds: Map<number, number[]>;
  textAnswers: Map<number, Map<number, string>>;
};

/** Whether {@link getAttendeeAnswersBatch} also fetches (and decrypts) the
 * free-text answer strings. Mandatory — pass `{ texts: false }` for the choice-
 * only contexts (edit form loads text on its own; the count summary can't show
 * free text) and `{ texts: true, privateKey }` for the table/CSV that display
 * each attendee's text. */
export type BatchTextOption =
  | { texts: false }
  | { texts: true; privateKey: CryptoKey };

/** Get answers for multiple attendees in a single query. */
export function getAttendeeAnswersBatch(
  attendeeIds: number[],
  option: { texts: false },
): Promise<Map<number, number[]>>;
export function getAttendeeAnswersBatch(
  attendeeIds: number[],
  option: { texts: true; privateKey: CryptoKey },
): Promise<AttendeeAnswersBatch>;
export async function getAttendeeAnswersBatch(
  attendeeIds: number[],
  option: BatchTextOption,
): Promise<Map<number, number[]> | AttendeeAnswersBatch> {
  if (!option.texts) return choiceAnswerIdsBatch(attendeeIds);
  const [answerIds, textAnswers] = await Promise.all([
    choiceAnswerIdsBatch(attendeeIds),
    getAttendeeTextAnswersBatch(attendeeIds, option.privateKey),
  ]);
  return { answerIds, textAnswers };
}

/** Questions across a set of listings plus each attendee's selected answers —
 * the shape the attendee table, calendar, groups and edit form all render. */
export type AttendeeQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
  /** attendeeId → (questionId → decrypted free-text answer). Present only when
   * the loader was asked to include text answers; absent/empty otherwise. */
  textAnswerMap?: Map<number, Map<number, string>>;
};

/**
 * Load the questions for a set of listings together with each attendee's chosen
 * answers, in parallel. Returns `undefined` when there's nothing to render —
 * no listings, no attendees, or no questions assigned — so callers can skip the
 * answers UI without an extra emptiness check.
 */
export const loadAttendeeQuestionData = async (
  listingIds: number[],
  attendeeIds: number[],
  privateKey?: CryptoKey,
): Promise<AttendeeQuestionData | undefined> => {
  if (attendeeIds.length === 0 || listingIds.length === 0) return undefined;
  const [{ questions }, answers] = await Promise.all([
    getQuestionsWithListingIds(listingIds),
    privateKey
      ? getAttendeeAnswersBatch(attendeeIds, { privateKey, texts: true })
      : getAttendeeAnswersBatch(attendeeIds, { texts: false }),
  ]);
  if (questions.length === 0) return undefined;
  // `texts: false` returns a plain choice-answer Map; `texts: true` returns the
  // choice map plus decrypted free-text answers for the table cells.
  return answers instanceof Map
    ? { attendeeAnswerMap: answers, questions }
    : {
        attendeeAnswerMap: answers.answerIds,
        questions,
        textAnswerMap: answers.textAnswers,
      };
};

/** Get free-text answers for one attendee, decrypted for owner/admin edit. */
export const getAttendeeTextAnswers = async (
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<Map<number, string>> =>
  (await getAttendeeTextAnswersBatch([attendeeId], privateKey)).get(
    attendeeId,
  ) ?? new Map();

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
     WHERE aa.answer_id IS NOT NULL AND aa.attendee_id = ?`,
    [attendeeId],
  );

  const result = new Map<number, { answerId: number; answerText: string }>();
  for (const row of rows) {
    const decrypted = await answersTable.fromDb({
      active: true,
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

/** Delete a question and all related data in a single batch. Every
 * attendee_answers row carries question_id (choice and free-text alike, the
 * validate trigger enforces it), so the answers delete by it directly. The
 * answer→modifier link is a column on answers, so it's removed with the rows. */
export const deleteQuestion = async (questionId: number): Promise<void> => {
  await executeBatch([
    {
      args: [questionId],
      sql: "DELETE FROM attendee_answers WHERE question_id = ?",
    },
    { args: [questionId], sql: "DELETE FROM answers WHERE question_id = ?" },
    {
      args: [questionId],
      sql: "DELETE FROM listing_questions WHERE question_id = ?",
    },
    { args: [questionId], sql: "DELETE FROM questions WHERE id = ?" },
  ]);
};

/** Delete an answer and all related attendee answers in a single batch (its
 * modifier_id link is a column on the row, so it's removed with the answer). */
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

// ---------------------------------------------------------------------------
// Answer selection aggregate (answers.times_selected)
// ---------------------------------------------------------------------------

/** The owner-editable, trigger-maintained aggregate columns on an answer. */
export const ANSWER_AGGREGATE_FIELDS = ["times_selected"] as const;

export type AnswerAggregateField = (typeof ANSWER_AGGREGATE_FIELDS)[number];

export type AnswerAggregateValues = Record<AnswerAggregateField, number>;

export type AnswerAggregateRecalculation = Record<
  AnswerAggregateField,
  { current: number; recalculated: number }
>;

/** The stored selection total (times_selected) for every answer of a question,
 * keyed by answer id. Reads the trigger-maintained column directly rather than
 * scanning attendee_answers, so the question detail page is a single row read. */
export const getAnswerSelectionTotals = async (
  questionId: number,
): Promise<Map<number, number>> => {
  const rows = await queryAll<{ id: number; times_selected: number }>(
    "SELECT id, times_selected FROM answers WHERE question_id = ?",
    [questionId],
  );
  return new Map(
    map(
      ({ id, times_selected }: { id: number; times_selected: number }) =>
        [id, times_selected] as const,
    )(rows),
  );
};

/** The answer's stored times_selected together with the value it would hold if
 * rebuilt from attendee_answers, so the edit page can flag (and the recalculate
 * flow can repair) a drifted aggregate. */
export const getAnswerAggregateRecalculation = async (
  answerId: number,
): Promise<AnswerAggregateRecalculation> => {
  const row = (await queryOne<{ current: number; recalculated: number }>(
    `SELECT times_selected AS current,
            (SELECT COUNT(*) FROM attendee_answers WHERE answer_id = answers.id)
              AS recalculated
     FROM answers WHERE id = ?`,
    [answerId],
  ))!;
  return {
    times_selected: { current: row.current, recalculated: row.recalculated },
  };
};

/** Manually set an answer's editable aggregate from the edit form. */
export const updateAnswerAggregateValues = async (
  answerId: number,
  values: AnswerAggregateValues,
): Promise<void> => {
  await execute("UPDATE answers SET times_selected = ? WHERE id = ?", [
    values.times_selected,
    answerId,
  ]);
};

const answerAggregateResetSql: Record<AnswerAggregateField, string> = {
  times_selected:
    "times_selected = COALESCE((SELECT COUNT(*) FROM attendee_answers WHERE answer_id = ?), 0)",
};

/** Reset selected answer aggregate columns from the actual attendee_answers. */
export const resetAnswerAggregateFields = async (
  answerId: number,
  fields: AnswerAggregateField[],
): Promise<void> => {
  await resetAggregates("answers", answerId, fields, answerAggregateResetSql);
};

/** Get the price-modifier id a single answer triggers, or null when it has
 * none. The modifier_id column isn't part of the decrypted Answer shape, so the
 * answer edit page reads it directly to pre-select the modifier dropdown. */
export const getAnswerModifierId = async (
  answerId: number,
): Promise<number | null> => {
  const row = await queryOne<{ modifier_id: number | null }>(
    "SELECT modifier_id FROM answers WHERE id = ?",
    [answerId],
  );
  return row?.modifier_id ?? null;
};

/** Point a single answer at an "answer"-trigger modifier, or clear the link
 * (null). The inverse of setModifierAnswers, driven from the answer's own edit
 * page so an answer carries at most one modifier. */
export const setAnswerModifier = async (
  answerId: number,
  modifierId: number | null,
): Promise<void> => {
  await execute("UPDATE answers SET modifier_id = ? WHERE id = ?", [
    modifierId,
    answerId,
  ]);
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
export const swapQuestionOrder = (
  questionId1: number,
  questionId2: number,
): Promise<void> => swapSortOrder("questions", questionId1, questionId2);

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
