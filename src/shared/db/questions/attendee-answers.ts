/**
 * Saving and reading attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch (deleting their old answers first so the string-refcount
 * trigger fires before the strings are recreated). Reads serve both the
 * choice-only summaries and the owner-key-decrypted free-text table cells.
 */

import type { InValue } from "@libsql/client";
import { groupBy, mapParallel, unique } from "#fp";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { executeBatch, inPlaceholders, queryAll } from "#shared/db/client.ts";
import { columnMapByIds } from "#shared/db/query.ts";
import type {
  QuestionWithAnswers,
  TextAnswer,
  TextAnswerId,
} from "#shared/db/question-types.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions/queries.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { answersTable } from "#shared/db/questions/tables.ts";

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
 *
 * The DELETE runs in its own committed batch ahead of the INSERT (rather than
 * both in one `withTransaction`), for two reasons:
 *
 * 1. `getOrCreateStringIds` between the two batches is itself a write-mode
 *    `executeBatchWithResults` (insert-or-ignore + refresh `created` + a
 *    read-your-own-writes SELECT). libsql's `batch()` always starts its own
 *    implicit transaction, so it cannot share an outer interactive
 *    transaction's `TxScope` — wrapping the whole flow in `withTransaction`
 *    would not make the two batches atomic. Threading a `TxScope` through
 *    `getOrCreateStringIds` (replacing its batch with per-statement `tx.execute`)
 *    is the only way to get true atomicity, and is left as a follow-up: the
 *    read-your-writes invariant the in-between SELECT relies on is subtle, and
 *    reworking it belongs in a focused change rather than this module split.
 * 2. The DELETE's trigger decrements `strings.used_count`; the subsequent
 *    `getOrCreateStringIds` refreshes `created` on the strings it re-inserts so
 *    the age-based pruner does not drop a string this save still references. The
 *    delete must commit before that refresh so the pruner sees a consistent
 *    `used_count` snapshot (a string now at 0 because this attendee was its last
 *    user is then re-created or refreshed by the insert path). A future
 *    transactional version must preserve this ordering inside the tx.
 *
 * The narrow gap: if the INSERT batch fails after the DELETE committed, the
 * attendee is left with no answers until the next re-save. A genuine INSERT
 * failure here means the database is already broken (the same write path every
 * other write takes), so we let it throw rather than add a partial-rollback
 * shim around an effectively-impossible branch.
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
  // The delete fires the string-refcount trigger (decrementing `used_count`),
  // and must commit before getOrCreateStringIds below refreshes `created` on the
  // strings we re-insert — see the doc comment on saveAttendeeAnswers for why
  // the two batches stay split and why the in-between string interning needs the
  // delete's effects visible.
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
      questionIdsByAnswerId(
        unique([...normalized.values()].flatMap((set) => set.answerIds)),
      ),
      existingQuestionIds(
        unique(
          [...normalized.values()].flatMap((set) => [
            ...set.textAnswerIds.map((answer) => answer.questionId),
            ...set.textAnswers.map((answer) => answer.questionId),
          ]),
        ),
      ),
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
        .map(() => "(?, ?,?)")
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

/** Group `(attendee_id, answer_id)` rows into an attendee → answer-ids map. */
const choiceAnswerMapFromRows = (
  rows: { attendee_id: number; answer_id: number }[],
): Map<number, number[]> =>
  new Map(
    [...groupBy(rows, (r) => r.attendee_id)].map(
      ([id, rs]) => [id, rs.map((r) => r.answer_id)] as const,
    ),
  );

/** Load `attendee_answers` rows for a set of attendees, restricted to rows where
 * `column` is set (non-null). Returns an empty array for an empty attendee
 * list, so the two batch readers (choice ids, decrypted free-text) share one
 * empty-guard + IN-clause query instead of each spelling it out. */
const selectAttendeeAnswerRows = <R>(
  attendeeIds: number[],
  column: string,
  selectColumns: string,
  join = "",
): Promise<R[]> =>
  attendeeIds.length === 0
    ? Promise.resolve([])
    : queryAll<R>(
        `SELECT ${selectColumns}
         FROM attendee_answers AS attendee_answer
         ${join}
        WHERE attendee_answer.${column} IS NOT NULL
          AND attendee_answer.attendee_id IN (${inPlaceholders(attendeeIds)})`,
        attendeeIds,
      );

const choiceAnswerIdsBatch = async (
  attendeeIds: number[],
): Promise<Map<number, number[]>> =>
  choiceAnswerMapFromRows(
    await selectAttendeeAnswerRows<{ attendee_id: number; answer_id: number }>(
      attendeeIds,
      "answer_id",
      "attendee_answer.attendee_id, attendee_answer.answer_id",
    ),
  );

/**
 * Attendee → chosen-answer-ids map for every real (`kind = 'attendee'`)
 * attendee booked onto one listing, scoped in SQL rather than by a per-attendee
 * id list. Choice ids are plaintext, so this needs no key material — the
 * Overview's answer summary counts them without decrypting any free text.
 */
export const getListingChoiceAnswerMap = async (
  listingId: number,
): Promise<Map<number, number[]>> => {
  const rows = await queryAll<{ attendee_id: number; answer_id: number }>(
    `SELECT attendee_answer.attendee_id, attendee_answer.answer_id
       FROM attendee_answers AS attendee_answer
      WHERE attendee_answer.answer_id IS NOT NULL
        AND attendee_answer.attendee_id IN (
          SELECT listingAttendee.attendee_id
            FROM listing_attendees AS listingAttendee
            JOIN attendees AS attendee
              ON attendee.id = listingAttendee.attendee_id
           WHERE listingAttendee.listing_id = ? AND attendee.kind = '${ATTENDEE_KIND}')`,
    [listingId],
  );
  return choiceAnswerMapFromRows(rows);
};

/** Row shape for a free-text answer joined onto its encrypted string. */
type TextAnswerRow = {
  attendee_id: number;
  encrypted_text: OwnerKeyEncrypted;
  question_id: number;
};

/** Decrypted free-text answers for several attendees: attendeeId → (questionId
 * → text). Needs the owner private key, so callers must opt in deliberately. */
export const getAttendeeTextAnswersBatch = async (
  attendeeIds: number[],
  privateKey: CryptoKey,
): Promise<Map<number, Map<number, string>>> => {
  const rows = await selectAttendeeAnswerRows<TextAnswerRow>(
    attendeeIds,
    "question_id",
    "attendee_answer.attendee_id, attendee_answer.question_id, string.encrypted_text",
    "JOIN strings AS string ON string.id = attendee_answer.string_id",
  );
  // Decrypt in parallel, then group by attendee into questionId→text maps.
  const decrypted = await mapParallel(async (row: TextAnswerRow) => ({
    attendeeId: row.attendee_id,
    questionId: row.question_id,
    text: await decryptWithOwnerKey(row.encrypted_text, privateKey),
  }))(rows);
  return new Map(
    [...groupBy(decrypted, (d) => d.attendeeId)].map(
      ([attendeeId, group]) =>
        [
          attendeeId,
          new Map(group.map((d) => [d.questionId, d.text] as const)),
        ] as const,
    ),
  );
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

/** Row shape for an attendee's chosen answer joined onto its decrypted text. */
type ChoiceAnswerRow = {
  answer_id: number;
  answer_text: string;
  question_id: number;
};

/** Get attendee answers mapped by question ID.
 * Returns Map<questionId, { answerId, answerText }> for a single attendee. */
export const getAttendeeAnswersByQuestion = async (
  attendeeId: number,
): Promise<Map<number, { answerId: number; answerText: string }>> => {
  const rows = await queryAll<ChoiceAnswerRow>(
    `SELECT answer.question_id, attendeeAnswer.answer_id, answer.text AS answer_text
     FROM attendee_answers AS attendeeAnswer
     JOIN answers AS answer ON answer.id = attendeeAnswer.answer_id
     WHERE attendeeAnswer.answer_id IS NOT NULL AND attendeeAnswer.attendee_id = ?`,
    [attendeeId],
  );
  // Decrypt each chosen answer in parallel, then key by question id.
  const decrypted = await mapParallel(async (row: ChoiceAnswerRow) => {
    const answer = await answersTable.fromDb({
      active: true,
      id: row.answer_id,
      question_id: row.question_id,
      sort_order: 0,
      text: row.answer_text,
    });
    return {
      answerId: row.answer_id,
      answerText: answer.text,
      questionId: row.question_id,
    };
  })(rows);
  return new Map(
    decrypted.map((d) => [
      d.questionId,
      { answerId: d.answerId, answerText: d.answerText },
    ]),
  );
};
