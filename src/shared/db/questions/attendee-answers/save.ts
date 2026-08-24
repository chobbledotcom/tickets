/**
 * Saving attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch (deleting their old answers first so the string-refcount
 * trigger fires before the strings are recreated).
 */

import {
  executeBatch,
  inPlaceholders,
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import type { TextAnswer, TextAnswerId } from "#db/question-types.ts";
import { internStringRows, prepareStringRows } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { txIdSet } from "#db/transaction.ts";
import { fieldById, unique } from "#fp";

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

const arrayOrEmpty = <T>(value: T[] | undefined): T[] =>
  value === undefined ? [] : value;

/** answer_id → question_id for the chosen ids, read on the open transaction so
 *  a deleted-between-checkout-and-finalize answer shows up as missing without
 *  starting a separate read transaction (the read shares the save's snapshot). */
const questionIdsByAnswerIdTx = async (
  tx: TxScope,
  answerIds: number[],
): Promise<Map<number, number>> => {
  if (answerIds.length === 0) return new Map();
  const rows = resultRows<{ id: number; question_id: number }>(
    await tx.execute(
      answersTable.read
        .pick(["id", "question_id"])
        .statement({ id: answerIds }),
    ),
  );
  return fieldById("question_id")(rows);
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

type NormalizedAnswerSet = AttendeeAnswerSet & {
  textAnswerIds: TextAnswerId[];
  textAnswers: TextAnswer[];
};

const storedIdAnswerStatements = (
  normalized: Map<number, NormalizedAnswerSet>,
): SqlStatement[] => {
  const attendeeIds = [...normalized.keys()];
  const statements: SqlStatement[] = [
    {
      args: attendeeIds,
      sql: `DELETE FROM attendee_answers WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    },
  ];
  const choiceRows = [...normalized].flatMap(([attendeeId, set]) =>
    set.answerIds.map((answerId, position) => ({
      answerId,
      attendeeId,
      position,
    })),
  );
  if (choiceRows.length > 0) {
    statements.push({
      args: choiceRows.flatMap((row) => [
        row.attendeeId,
        row.answerId,
        row.position,
      ]),
      sql: `WITH selected(attendee_id, answer_id, position) AS (
        VALUES ${choiceRows.map(() => "(?, ?, ?)").join(", ")}
      ), ranked AS (
        SELECT selected.attendee_id, selected.answer_id, answer.question_id,
          ROW_NUMBER() OVER (
            PARTITION BY selected.attendee_id, answer.question_id
            ORDER BY selected.position DESC
          ) AS choice_order
        FROM selected
        INNER JOIN answers AS answer ON answer.id = selected.answer_id
      )
      INSERT INTO attendee_answers (attendee_id, answer_id, question_id)
      SELECT attendee_id, answer_id, question_id
      FROM ranked
      WHERE choice_order = 1`,
    });
  }
  const textRows = [...normalized].flatMap(([attendeeId, set]) =>
    set.textAnswerIds.map((answer) => ({ attendeeId, ...answer })),
  );
  if (textRows.length > 0) {
    statements.push({
      args: textRows.flatMap((row) => [
        row.attendeeId,
        row.questionId,
        row.stringId,
      ]),
      sql: `WITH selected(attendee_id, question_id, string_id) AS (
        VALUES ${textRows.map(() => "(?, ?, ?)").join(", ")}
      )
      INSERT INTO attendee_answers (attendee_id, question_id, string_id)
      SELECT selected.attendee_id, selected.question_id, selected.string_id
      FROM selected
      INNER JOIN questions AS question ON question.id = selected.question_id`,
    });
  }
  return statements;
};

/** The subset of `questionIds` that still exist — text answers reference a
 *  question directly, so a question deleted between checkout and finalize must
 *  be dropped (mirrors the deleted-answer skip on the choice path) rather than
 *  inserting an orphan row whose plaintext the admin UI can never surface.
 *  Read on the open transaction so it shares the save's snapshot. */
const existingQuestionIdsTx = (
  tx: TxScope,
  questionIds: number[],
): Promise<Set<number>> =>
  txIdSet(tx, questionIds, (unique) =>
    questionsTable.read.pick(["id"]).statement({ id: unique }),
  );

/**
 * Replace every listed attendee's answers in one atomic transaction: the
 * existing answers are deleted, then the new set inserted, committing or
 * rolling back as one. Every save reduces to one map of attendee to their
 * answers — chosen ids alone, or an {@link AttendeeAnswerSet} carrying
 * typed-in text too. Repeated answers to a question collapse to the last.
 *
 * The encrypted and HMAC-indexed string rows are computed before the
 * transaction opens, since that work is CPU-bound and would otherwise hold the
 * SQLite writer open for nothing. Then, all on the transaction: delete every
 * attendee's rows in one `IN (…)`; read which questions and answers still
 * exist, so one deleted between checkout and finalize is skipped rather than
 * orphaned; intern the free-text rows in a fixed three round trips; and insert
 * at most two multi-row batches, so the statement count stays flat however
 * many attendees a save covers.
 *
 * The delete runs first so `used_count` is seen consistently: a string this
 * save drops to zero is re-created by the interning path. A failure anywhere
 * rolls the save back, so prior answers survive rather than being emptied.
 */
export const saveAttendeeAnswers = async (
  answersByAttendee: Map<number, number[] | AttendeeAnswerSet>,
): Promise<void> => {
  const normalized = new Map<number, NormalizedAnswerSet>(
    [...answersByAttendee].map(([id, set]) => {
      const answerSet = normalizeAnswerSet(set);
      return [
        id,
        {
          ...answerSet,
          textAnswerIds: dedupeByQuestion(
            arrayOrEmpty(answerSet.textAnswerIds),
          ),
          textAnswers: dedupeByQuestion(arrayOrEmpty(answerSet.textAnswers)),
        },
      ];
    }),
  );
  if (normalized.size === 0) return;
  const storedIdsOnly = [...normalized.values()].every(
    (set) => set.textAnswers.length === 0,
  );
  if (storedIdsOnly) {
    await executeBatch(storedIdAnswerStatements(normalized));
    return;
  }
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
    const answerIds = arrayOrEmpty(listingAnswerIds[key]);
    const textAnswers = arrayOrEmpty(listingTextAnswers[key]);
    if (answerIds.length === 0 && textAnswers.length === 0) continue;
    const saved = answersByAttendee.get(attendee.id);
    const existing = saved === undefined ? { answerIds: [] } : saved;
    existing.answerIds.push(...answerIds);
    if (textAnswers.length > 0) {
      existing.textAnswers = dedupeByQuestion([
        ...arrayOrEmpty(existing.textAnswers),
        ...textAnswers,
      ]);
    }
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
};
