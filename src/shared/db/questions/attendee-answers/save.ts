/**
 * Saving attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch (deleting their old answers first so the string-refcount
 * trigger fires before the strings are recreated).
 */

import { ATTENDEE_BY_TOKEN_SQL } from "#db/attendees/create-batch.ts";
import {
  executeBatch,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import type { TextAnswer, TextAnswerId } from "#db/question-types.ts";
import {
  internWriteStatements,
  type PreparedStringRow,
  prepareStringRows,
} from "#db/questions/strings.ts";

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

const dedupeByQuestion = <T extends { questionId: number }>(
  answers: T[],
): T[] => {
  const answerByQuestion = new Map<number, T>();
  for (const answer of answers) {
    answerByQuestion.set(answer.questionId, answer);
  }
  return [...answerByQuestion.values()];
};

export type NormalizedAnswerSet = AttendeeAnswerSet & {
  textAnswerIds: TextAnswerId[];
  textAnswers: TextAnswer[];
};

/** An answer save with all caller-side work done: the sets normalized and the
 * free text encrypted and blind-indexed, so the write itself is plain
 * statements a transaction or batch can carry. */
export type PreparedAnswerSave = {
  normalized: Map<number, NormalizedAnswerSet>;
  preparedStringRows: PreparedStringRow[];
};

/** The attendee an answer row belongs to, as the statements bind it. The
 * standalone save binds real attendee ids; the reservation boundary resolves
 * its one attendee from the ticket token the booking batch itself inserts, so
 * the statements need no attendee id before the batch runs. */
type AttendeeRef = {
  /** SQL for one attendee_id value slot. */
  slot: string;
  /** The value bound into that slot. */
  arg: (attendeeId: number) => string | number;
  /** The delete that clears the attendee's previous answers. */
  delete: (attendeeIds: number[]) => SqlStatement;
};

const idsRef: AttendeeRef = {
  arg: (attendeeId) => attendeeId,
  delete: (attendeeIds) => ({
    args: attendeeIds,
    sql: `DELETE FROM attendee_answers WHERE attendee_id IN (${attendeeIds
      .map(() => "?")
      .join(", ")})`,
  }),
  slot: "?",
};

/** The reservation boundary's attendee: the row the batch itself inserts,
 * found by token. The answer map carries a placeholder id it never binds. */
const bookedRef = (tokenIndex: string): AttendeeRef => ({
  arg: () => tokenIndex,
  delete: () => ({
    args: [tokenIndex],
    sql: `DELETE FROM attendee_answers WHERE attendee_id = ${ATTENDEE_BY_TOKEN_SQL}`,
  }),
  slot: ATTENDEE_BY_TOKEN_SQL,
});

/** One multi-row INSERT into attendee_answers: every row binds the attendee
 * slot first, then its own columns, each with the SQL slot it binds into (a
 * plain `?`, or the subselect that resolves a prepared text's string id by
 * its blind index). */
const answerRowsInsert = <Row extends { attendeeId: number }>(
  ref: AttendeeRef,
  columns: string,
  rows: readonly Row[],
  rowValues: (row: Row) => { binds: (string | number)[]; slots: string[] },
  afterValues: string,
): SqlStatement => ({
  args: rows.flatMap((row) => [
    ref.arg(row.attendeeId),
    ...rowValues(row).binds,
  ]),
  sql: `WITH selected(${columns}) AS (
        VALUES ${rows
          .map((row) => `(${ref.slot}, ${rowValues(row).slots.join(", ")})`)
          .join(", ")}
      ) ${afterValues}`,
});

/** The whole save as plain statements: delete the attendees' previous answers,
 * intern the prepared free-text strings, then re-insert the surviving choices
 * and texts. Deleted answers and questions drop out through the SQL joins, so
 * one deleted between checkout and finalize is skipped rather than orphaned.
 * The delete runs first so `used_count` is seen consistently: a string this
 * save drops to zero is re-created by interning.
 *
 * A prepared text answer binds its blind index and resolves the string id
 * inside the insert, in the same boundary that interned it. */
const answerSaveStatements = (
  { normalized, preparedStringRows }: PreparedAnswerSave,
  ref: AttendeeRef,
  alongside: SqlStatement[] = [],
): SqlStatement[] => {
  const statements: SqlStatement[] = [];
  const attendeeIds = [...normalized.keys()];
  if (attendeeIds.length > 0) statements.push(ref.delete(attendeeIds));
  if (preparedStringRows.length > 0) {
    statements.push(...internWriteStatements(preparedStringRows));
  }
  const choiceRows = [...normalized].flatMap(([attendeeId, set]) =>
    set.answerIds.map((answerId, position) => ({
      answerId,
      attendeeId,
      position,
    })),
  );
  if (choiceRows.length > 0) {
    statements.push(
      answerRowsInsert(
        ref,
        "attendee_id, answer_id, position",
        choiceRows,
        (row) => ({
          binds: [row.answerId, row.position],
          slots: ["?", "?"],
        }),
        // Last answer per question wins: the row numbers rank each question's
        // answers by position, descending, and only the first survives.
        `, ranked AS (
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
      ),
    );
  }
  const textIndexByText = new Map(
    preparedStringRows.map((row) => [row.text, row.textIndex]),
  );
  // One text row per question, the last answer winning: a stored string id
  // binds directly, a prepared answer binds its blind index and resolves the
  // id inside the insert.
  type TextRow = { questionId: number; value: number | string };
  const textRowsByQuestion = (set: NormalizedAnswerSet): TextRow[] => {
    const valueByQuestion = new Map<number, number | string>(
      set.textAnswerIds.map((answer) => [answer.questionId, answer.stringId]),
    );
    for (const answer of set.textAnswers) {
      valueByQuestion.set(answer.questionId, textIndexByText.get(answer.text)!);
    }
    return [...valueByQuestion].map(([questionId, value]) => ({
      questionId,
      value,
    }));
  };
  const textRows = [...normalized].flatMap(([attendeeId, set]) =>
    textRowsByQuestion(set).map((row) => ({ attendeeId, ...row })),
  );
  if (textRows.length > 0) {
    statements.push(
      answerRowsInsert(
        ref,
        "attendee_id, question_id, string_id",
        textRows,
        (row) => ({
          binds: [row.questionId, row.value],
          slots: [
            "?",
            typeof row.value === "string"
              ? "(SELECT id FROM strings WHERE text_index = ?)"
              : "?",
          ],
        }),
        // The questions join drops a question deleted between checkout and
        // finalize instead of inserting an orphan row.
        `INSERT INTO attendee_answers (attendee_id, question_id, string_id)
        SELECT selected.attendee_id, selected.question_id, selected.string_id
        FROM selected
        INNER JOIN questions AS question ON question.id = selected.question_id`,
      ),
    );
  }
  return [...statements, ...alongside];
};

/**
 * Repeated answers to a question collapse to the last. `alongside` runs after
 * the answers in the same write, even when there are no answers to save.
 *
 * The string rows are encrypted and indexed BEFORE the transaction opens. That
 * work is CPU-bound and would otherwise hold the SQLite writer open for nothing.
 */
export const prepareAttendeeAnswerSave = async (
  answersByAttendee: Map<number, number[] | AttendeeAnswerSet>,
): Promise<PreparedAnswerSave> => {
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
  const preparedStringRows = await prepareStringRows(
    [...normalized.values()].flatMap((set) =>
      set.textAnswers.map((a) => a.text),
    ),
  );
  return { normalized, preparedStringRows };
};

/** Run a prepared answer save on the caller's open transaction, so a caller
 * that already holds one (a reservation boundary) keeps its own atomicity.
 * The save always writes something: the caller's guard rules out an empty
 * save, and a save with attendees always emits its delete. */
export const saveAttendeeAnswersTx = async (
  tx: TxScope,
  prepared: PreparedAnswerSave,
  alongside: SqlStatement[] = [],
): Promise<void> => {
  await tx.batch(answerSaveStatements(prepared, idsRef, alongside));
};

/**
 * Save each attendee's answers in one atomic write. With no free text the save
 * is pure statements and runs as one batch; free text wraps the same
 * statements in one transaction.
 */
export const saveAttendeeAnswers = async (
  answersByAttendee: Map<number, number[] | AttendeeAnswerSet>,
  alongside: SqlStatement[] = [],
): Promise<void> => {
  const prepared = await prepareAttendeeAnswerSave(answersByAttendee);
  if (prepared.normalized.size === 0 && alongside.length === 0) return;
  if (prepared.preparedStringRows.length === 0) {
    await executeBatch(answerSaveStatements(prepared, idsRef, alongside));
    return;
  }
  await withTransaction((tx) => saveAttendeeAnswersTx(tx, prepared, alongside));
};

/** The save's statements for a reservation boundary: the one attendee is
 * resolved from the ticket token the booking batch itself inserts, so the
 * answer rows commit in the same atomic batch as the booking. The answer map
 * carries one placeholder-keyed set. */
export const bookedAnswerSaveStatements = (
  prepared: PreparedAnswerSave,
  tokenIndex: string,
): SqlStatement[] => answerSaveStatements(prepared, bookedRef(tokenIndex));

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
