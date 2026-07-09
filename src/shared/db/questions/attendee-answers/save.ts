/**
 * Saving attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch (deleting their old answers first so the string-refcount
 * trigger fires before the strings are recreated).
 */

import type { InValue } from "@libsql/client";
import { unique } from "#fp";
import { executeBatch, inPlaceholders, queryAll } from "#shared/db/client.ts";
import { columnMapByIds } from "#shared/db/query.ts";
import type { TextAnswer, TextAnswerId } from "#shared/db/question-types.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";

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
