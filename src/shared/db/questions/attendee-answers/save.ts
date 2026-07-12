/**
 * Saving attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch (deleting their old answers first so the string-refcount
 * trigger fires before the strings are recreated).
 */

import { unique } from "#fp";
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import type { TextAnswer, TextAnswerId } from "#shared/db/question-types.ts";
import {
  internStringRows,
  prepareStringRows,
} from "#shared/db/questions/strings.ts";

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

/** answer_id → question_id for the chosen ids, read on the open transaction so
 *  a deleted-between-checkout-and-finalize answer shows up as missing without
 *  starting a separate read transaction (the read shares the save's snapshot). */
const questionIdsByAnswerIdTx = async (
  tx: TxScope,
  answerIds: number[],
): Promise<Map<number, number>> => {
  if (answerIds.length === 0) return new Map();
  const rows = resultRows<{ id: number; question_id: number }>(
    await tx.execute({
      args: answerIds,
      sql: `SELECT answer.id, answer.question_id FROM answers AS answer WHERE answer.id IN (${inPlaceholders(answerIds)})`,
    }),
  );
  return new Map(rows.map((row) => [row.id, row.question_id]));
};

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
 *  question directly, so a question deleted between checkout and finalize must
 *  be dropped (mirrors the deleted-answer skip on the choice path) rather than
 *  inserting an orphan row whose plaintext the admin UI can never surface.
 *  Read on the open transaction so it shares the save's snapshot. */
const existingQuestionIdsTx = async (
  tx: TxScope,
  questionIds: number[],
): Promise<Set<number>> => {
  if (questionIds.length === 0) return new Set();
  const rows = resultRows<{ id: number }>(
    await tx.execute({
      args: questionIds,
      sql: `SELECT id FROM questions WHERE id IN (${inPlaceholders(questionIds)})`,
    }),
  );
  return new Set(rows.map((row) => row.id));
};

/**
 * Replace every listed attendee's answers in one atomic transaction: each
 * attendee's existing answers are deleted, then their new answer set inserted,
 * committing (or rolling back) as one. The `Map<attendeeId, answerIds>` is the
 * single shape every save situation reduces to — one answer set shared across
 * attendees, a by-question selection, or the per-listing grouping from
 * `groupListingAnswerSets` — so callers build the map and this builds the SQL.
 * Repeated question answers collapse to the last value before insert, matching
 * the single-answer-per-question invariant.
 *
 * The delete, the in-between reads, the free-text string interning, and the
 * insert all run inside one `withTransaction` on `tx.execute`:
 *
 * 0. Precompute the encrypted + HMAC-indexed string rows BEFORE opening the
 *    transaction (`prepareStringRows`). The crypto is CPU-bound and holds no DB
 *    statement, so running it inside the tx would hold the SQLite writer open
 *    for nothing; doing it up front keeps only real statements on the tx.
 * 1. DELETE — one `IN (...)` statement for every attendee at once; SQLite
 *    triggers fire per affected row (there is no statement-level trigger form),
 *    so `strings.used_count` is decremented once per row regardless of whether
 *    the DELETE matches one row or many.
 * 2. Read `answer_id → question_id` and which text questions still exist, so a
 *    question or answer deleted between checkout and finalize is skipped rather
 *    than producing an orphan row. These run on the tx to share the save's
 *    snapshot.
 * 3. Intern the precomputed free-text rows via `internStringRows(rows, tx)` —
 *    one batched multi-row `INSERT OR IGNORE` + refresh `created` + one
 *    read-your-writes `SELECT`, all on the tx, so the SELECT sees the rows the
 *    INSERT just wrote in the same transaction. The intern phase is a fixed 3
 *    round trips regardless of how many unique texts are saved.
 * 4. INSERT — at most two multi-row `VALUES` batches: one for every attendee's
 *    choice answers, one for every attendee's text answers. Batching across
 *    attendees keeps the statement count at a handful regardless of how many
 *    attendees a multi-listing/package save covers, staying within the
 *    transaction round-trip guard.
 *
 * The delete runs before the string refresh so a consistent `used_count`
 * snapshot is seen: a string this save drops to 0 (its last attendee removed) is
 * then re-created or refreshed by the interning path, keeping it alive past its
 * now-stale reference until this save re-inserts. Atomicity: a failure in any
 * step rolls the whole save back — an attendee's prior answers survive a failed
 * re-save rather than being left empty (the gap the previous two-batch
 * delete-then-insert left when the INSERT failed after the DELETE had committed).
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
  // Precompute the encrypted + HMAC-indexed string rows BEFORE opening the
  // transaction. The crypto (hybrid encryption + blind index) is CPU-bound and
  // holds no DB statement; running it inside `withTransaction` would keep the
  // SQLite writer open while no statement is running, blocking unrelated writes
  // and pushing the transaction toward its round-trip/time-out guard. Doing it
  // up front means only the actual INSERT/UPDATE/SELECT land on the tx.
  const preparedStringRows = await prepareStringRows(
    [...normalized.values()].flatMap((set) =>
      set.textAnswers.map((a) => a.text),
    ),
  );
  await withTransaction(async (tx) => {
    // Delete every attendee's existing answers in one statement. SQLite
    // triggers fire per affected row (there is no statement-level trigger
    // form), so strings.used_count is decremented once per row whether the
    // DELETE matches one attendee or many. The interning below then refreshes
    // `created` on the strings this save re-references, so the order
    // (delete → intern → insert) keeps a consistent used_count snapshot.
    const attendeeIds = [...normalized.keys()];
    await tx.execute({
      args: attendeeIds,
      sql: `DELETE FROM attendee_answers WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    });
    const answerIds = unique(
      [...normalized.values()].flatMap((set) => set.answerIds),
    );
    const textQuestionIds = unique(
      [...normalized.values()].flatMap((set) => [
        ...set.textAnswerIds.map((answer) => answer.questionId),
        ...set.textAnswers.map((answer) => answer.questionId),
      ]),
    );
    // Run the reads and string interning sequentially on the tx — concurrent
    // tx.execute calls share the one transaction connection, so serialising
    // avoids interleaved statements. The reads touch different tables than the
    // delete but run on the tx to share the save's snapshot.
    const questionIdsByAnswer = await questionIdsByAnswerIdTx(tx, answerIds);
    const liveTextQuestionIds = await existingQuestionIdsTx(
      tx,
      textQuestionIds,
    );
    const stringIds = await internStringRows(preparedStringRows, tx);
    // Collect every attendee's rows, then emit at most two multi-row INSERTs
    // (one for choice answers, one for text answers) so the statement count
    // stays at a handful regardless of attendee count — the transaction
    // round-trip guard thresholds a chatty per-attendee loop would trip.
    // One row of a pending INSERT: an attendee, a question, and the one value
    // column that varies (a chosen answer id, or an interned text id).
    type AnswerRow = {
      attendeeId: number;
      questionId: number;
      valueId: number;
    };
    const choiceRows: AnswerRow[] = [];
    const textRows: AnswerRow[] = [];
    for (const [
      attendeeId,
      { answerIds, textAnswerIds, textAnswers },
    ] of normalized) {
      const dedupedAnswerIds = dedupeAnswerIdsByQuestion(
        answerIds,
        questionIdsByAnswer,
      );
      for (const id of dedupedAnswerIds) {
        choiceRows.push({
          attendeeId,
          questionId: questionIdsByAnswer.get(id)!,
          valueId: id,
        });
      }
      const resolvedTextAnswerIds = dedupeTextAnswerIdsByQuestion([
        ...textAnswerIds,
        ...textAnswers.map((answer) => ({
          questionId: answer.questionId,
          stringId: stringIds.get(answer.text)!,
        })),
      ]).filter((answer) => liveTextQuestionIds.has(answer.questionId));
      for (const answer of resolvedTextAnswerIds) {
        textRows.push({
          attendeeId,
          questionId: answer.questionId,
          valueId: answer.stringId,
        });
      }
    }
    // Emit one multi-row INSERT of answer rows into the given value column.
    // Both answer kinds write the same three columns, so they share this body.
    const insertAnswerRows = (
      valueColumn: "answer_id" | "string_id",
      rows: AnswerRow[],
    ): Promise<unknown> => {
      const placeholders = rows.map(() => "(?, ?, ?)").join(", ");
      return tx.execute({
        args: rows.flatMap((row) => [
          row.attendeeId,
          row.questionId,
          row.valueId,
        ]),
        sql: `INSERT INTO attendee_answers (attendee_id, question_id, ${valueColumn}) VALUES ${placeholders}`,
      });
    };
    if (choiceRows.length > 0) await insertAnswerRows("answer_id", choiceRows);
    if (textRows.length > 0) await insertAnswerRows("string_id", textRows);
  });
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
 * listing's answers; listings with no answers contribute nothing. Repeated
 * text answers for one question keep the last value, matching the
 * single-answer-per-question invariant. `listingTextAnswers` is optional
 * because a choice-only save legitimately has no text answers. Feeds the map
 * straight into `saveAttendeeAnswers`.
 */
export const groupListingAnswerSets = (
  entries: AttendeeListingEntry[],
  listingAnswerIds: Record<string, number[]>,
  listingTextAnswers: Record<string, TextAnswer[]> = {},
): Map<number, AttendeeAnswerSet> => {
  const answersByAttendee = new Map<number, AttendeeAnswerSet>();
  for (const { attendee, listing } of entries) {
    const key = String(listing.id);
    const answerIds = listingAnswerIds[key] ?? [];
    const textAnswers = listingTextAnswers[key] ?? [];
    if (answerIds.length === 0 && textAnswers.length === 0) continue;
    const existing = answersByAttendee.get(attendee.id) ?? { answerIds: [] };
    existing.answerIds.push(...answerIds);
    if (textAnswers.length > 0) {
      existing.textAnswers = dedupeByQuestion([
        ...(existing.textAnswers ?? []),
        ...textAnswers,
      ]);
    }
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
};
