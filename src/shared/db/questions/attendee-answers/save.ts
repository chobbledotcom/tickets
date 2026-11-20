/**
 * Saving attendee answers.
 *
 * Each attendee's chosen answer ids and free-text strings are written in one
 * atomic batch. The old booking answers go first, so the string count
 * trigger fires before the strings are recreated.
 */

import { attendeeByToken } from "#db/attendees/create-batch.ts";
import { executeBatch, type TxScope, withTransaction } from "#db/client.ts";
import type {
  LineTextAnswer,
  LineTextAnswerId,
  TextAnswer,
  TextAnswerId,
} from "#db/question-types.ts";
import {
  internWriteStatements,
  type PreparedStringRow,
  prepareStringRows,
} from "#db/questions/strings.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlSlot, type SqlStatement, sql, sqlRows } from "#db/sql.ts";
import { deleteFrom } from "#db/write.ts";
import { requiredMapValue } from "#fp";

export type AttendeeAnswerSet = {
  answerIds: number[];
  /** The answers to questions that ask once for each booked listing. Each is
   * filed against the attendee's booking row for its listing. */
  lineAnswers?: (LineTextAnswer | LineTextAnswerId)[];
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

/** One answer for each question and listing: a repeat keeps the last. */
const dedupeByQuestionAndListing = <
  T extends { listingId: number; questionId: number },
>(
  answers: T[],
): T[] => [
  ...new Map(
    answers.map((answer) => [
      `${answer.questionId}:${answer.listingId}`,
      answer,
    ]),
  ).values(),
];

type NormalizedAnswerSet = AttendeeAnswerSet & {
  lineAnswers: (LineTextAnswer | LineTextAnswerId)[];
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
 * standalone save binds real attendee ids. The reservation boundary resolves
 * its one attendee from the ticket token the booking batch itself inserts, so
 * the statements need no attendee id before the batch runs. */
type AttendeeRef = {
  /** The attendee_id value of one row. */
  idOf: (attendeeId: number) => SqlSlot;
  /** The delete that clears the attendee's previous booking answers. */
  delete: (attendeeIds: number[]) => SqlStatement;
};

const idsRef: AttendeeRef = {
  delete: (attendeeIds) =>
    deleteFrom(tables.attendee_answers).where({
      attendeeId: attendeeIds,
      bookingRowId: null,
    }),
  idOf: (attendeeId) => attendeeId,
};

/** The reservation boundary's attendee: the row the batch itself inserts,
 * found by token. The answer map carries a placeholder id it never binds. */
const bookedRef = (tokenIndex: string): AttendeeRef => {
  const attendee = attendeeByToken(tokenIndex);
  return {
    delete: () =>
      deleteFrom(tables.attendee_answers).where({
        attendeeId: attendee,
        bookingRowId: null,
      }),
    idOf: () => attendee,
  };
};

/** One multi-row INSERT into attendee_answers: every row holds the attendee
 * first, then its own column values (a bound value, or the subquery that
 * finds a prepared text's string id by its blind index). */
const answerRowsInsert = <Row extends { attendeeId: number }>(
  ref: AttendeeRef,
  columns: SqlStatement,
  rows: readonly Row[],
  rowValues: (row: Row) => SqlSlot[],
  afterValues: SqlStatement,
): SqlStatement =>
  sql`WITH selected(${columns}) AS (
        VALUES ${sqlRows(
          rows.map((row) => [ref.idOf(row.attendeeId), ...rowValues(row)]),
        )}
      ) ${afterValues}`;

/** Adds the insert for these rows, or nothing when there are none. */
const pushAnswerRows = <Row extends { attendeeId: number }>(
  statements: SqlStatement[],
  ref: AttendeeRef,
  insert: {
    columns: SqlStatement;
    rows: readonly Row[];
    rowValues: (row: Row) => SqlSlot[];
    afterValues: SqlStatement;
  },
): void => {
  if (insert.rows.length === 0) return;
  statements.push(
    answerRowsInsert(
      ref,
      insert.columns,
      insert.rows,
      insert.rowValues,
      insert.afterValues,
    ),
  );
};

const attendeeRows = <Row extends object>(
  normalized: Map<number, NormalizedAnswerSet>,
  rowsOf: (set: NormalizedAnswerSet) => Row[],
) =>
  [...normalized].flatMap(([attendeeId, set]) =>
    rowsOf(set).map((row) => ({ attendeeId, ...row })),
  );

/** The string id of a stored answer, or the lookup that finds the id of a
 * prepared answer by its blind index. */
const stringIdOf = (value: number | string): SqlSlot =>
  typeof value === "string"
    ? sql`(SELECT id FROM strings WHERE text_index = ${value})`
    : value;

/** The insert of each listing's own answers. The join to the attendee's
 * booking rows files an answer against every row the attendee holds for its
 * listing. A row with no booked quantity takes none. */
const lineAnswerStatements = (
  normalized: Map<number, NormalizedAnswerSet>,
  ref: AttendeeRef,
  textIndexByText: Map<string, string>,
): SqlStatement[] => {
  const rows = attendeeRows(normalized, (set) =>
    set.lineAnswers.map((answer) => ({
      listingId: answer.listingId,
      questionId: answer.questionId,
      value:
        "text" in answer
          ? requiredMapValue(
              textIndexByText,
              answer.text,
              `Text answer for question ${answer.questionId} missing`,
            )
          : answer.stringId,
    })),
  );
  const statements: SqlStatement[] = [];
  pushAnswerRows(statements, ref, {
    afterValues: sql`INSERT INTO attendee_answers
          (attendee_id, question_id, string_id, booking_row_id)
        SELECT selected.attendee_id, selected.question_id, selected.string_id, line.id
        FROM selected
        INNER JOIN questions AS question ON question.id = selected.question_id
        INNER JOIN listing_attendees AS line
          ON line.attendee_id = selected.attendee_id
          AND line.listing_id = selected.listing_id
          AND line.quantity > 0`,
    columns: sql`attendee_id, question_id, listing_id, string_id`,
    rows,
    rowValues: (row) => [row.questionId, row.listingId, stringIdOf(row.value)],
  });
  return statements;
};

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
  const choiceRows = attendeeRows(normalized, (set) =>
    set.answerIds.map((answerId, position) => ({ answerId, position })),
  );
  pushAnswerRows(statements, ref, {
    // Last answer per question wins: the row numbers rank each question's
    // answers by position, descending, and only the first survives.
    afterValues: sql`, ranked AS (
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
    columns: sql`attendee_id, answer_id, position`,
    rows: choiceRows,
    rowValues: (row) => [row.answerId, row.position],
  });
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
      valueByQuestion.set(
        answer.questionId,
        requiredMapValue(
          textIndexByText,
          answer.text,
          `Text answer for question ${answer.questionId} missing`,
        ),
      );
    }
    return [...valueByQuestion].map(([questionId, value]) => ({
      questionId,
      value,
    }));
  };
  const textRows = attendeeRows(normalized, textRowsByQuestion);
  pushAnswerRows(statements, ref, {
    // The questions join drops a question deleted between checkout and
    // finalize instead of inserting an orphan row.
    afterValues: sql`INSERT INTO attendee_answers (attendee_id, question_id, string_id)
        SELECT selected.attendee_id, selected.question_id, selected.string_id
        FROM selected
        INNER JOIN questions AS question ON question.id = selected.question_id`,
    columns: sql`attendee_id, question_id, string_id`,
    rows: textRows,
    rowValues: (row) => [row.questionId, stringIdOf(row.value)],
  });
  return [
    ...statements,
    ...lineAnswerStatements(normalized, ref, textIndexByText),
    ...alongside,
  ];
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
          lineAnswers: dedupeByQuestionAndListing(
            arrayOrEmpty(answerSet.lineAnswers),
          ),
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
      [...set.textAnswers, ...set.lineAnswers].flatMap((a) =>
        "text" in a ? [a.text] : [],
      ),
    ),
  );
  return { normalized, preparedStringRows };
};

/** Bind a prepared answer save onto one real attendee id. A save that must
 * ride a create transaction is prepared with a placeholder key first. This
 * rekeys each set onto the id the insert made. The prepared string
 * rows are reused as-is. Only the attendee key changes. */
export const bindPreparedSaveToAttendee = (
  prepared: PreparedAnswerSave,
  attendeeId: number,
): PreparedAnswerSave => ({
  ...prepared,
  normalized: new Map(
    [...prepared.normalized.values()].map((set) => [attendeeId, set]),
  ),
});

/** Run a prepared answer save on the caller's open transaction, so a caller
 *  that already holds one keeps its own atomicity. The save always writes
 *  something: the caller's guard rules out an empty save, and a save with
 *  attendees always emits its delete. */
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

/** Names the listing that owns each of these answers. */
const withListing = <T extends { questionId: number }>(
  listingId: number,
  answers: T[] | undefined,
): (T & { listingId: number })[] =>
  arrayOrEmpty(answers).map((answer) => ({ ...answer, listingId }));

/** One listing's answers, as they join its attendee's set. */
type ListingAnswers = {
  answerIds: number[];
  lines: (LineTextAnswer | LineTextAnswerId)[];
  textAnswers: TextAnswer[];
  textRefs: TextAnswerId[];
};

/** Adds one listing's answers to its attendee's set. A booking answer keeps
 * its last text. A listing's own answers never merge by question. */
const addListingAnswers = (
  existing: AttendeeAnswerSet,
  added: ListingAnswers,
): void => {
  existing.answerIds.push(...added.answerIds);
  if (added.textAnswers.length > 0) {
    existing.textAnswers = dedupeByQuestion([
      ...arrayOrEmpty(existing.textAnswers),
      ...added.textAnswers,
    ]);
  }
  if (added.textRefs.length > 0) {
    existing.textAnswerIds = dedupeByQuestion([
      ...arrayOrEmpty(existing.textAnswerIds),
      ...added.textRefs,
    ]);
  }
  if (added.lines.length > 0) {
    existing.lineAnswers = [
      ...arrayOrEmpty(existing.lineAnswers),
      ...added.lines,
    ];
  }
};

/**
 * Reduce per-listing answer selections to one answer set per attendee. An
 * attendee booking several listings in the same submission accumulates every
 * listing's answers; listings with no answers contribute nothing. Repeated
 * text answers for one question keep the last value, matching the
 * single-answer-per-question invariant. `listingTextAnswers` is optional
 * because a choice-only save legitimately has no text answers.
 * `listingTextRefs` carries the same answers the other way round, as the
 * string ids a checkout's intent stores; both merge into the same set. Feeds
 * the map straight into `saveAttendeeAnswers`.
 */
export const groupListingAnswerSets = (
  entries: AttendeeListingEntry[],
  listingAnswerIds: Record<string, number[]>,
  listingTextAnswers: Record<string, TextAnswer[]> = {},
  listingTextRefs: Record<string, TextAnswerId[]> = {},
  lineAnswers: Record<string, (TextAnswer | TextAnswerId)[]> = {},
): Map<number, AttendeeAnswerSet> => {
  const answersByAttendee = new Map<number, AttendeeAnswerSet>();
  for (const { attendee, listing } of entries) {
    const key = String(listing.id);
    const added: ListingAnswers = {
      answerIds: arrayOrEmpty(listingAnswerIds[key]),
      lines: withListing(listing.id, lineAnswers[key]),
      textAnswers: arrayOrEmpty(listingTextAnswers[key]),
      textRefs: arrayOrEmpty(listingTextRefs[key]),
    };
    if (Object.values(added).every((answers) => answers.length === 0)) continue;
    const saved = answersByAttendee.get(attendee.id);
    const existing = saved === undefined ? { answerIds: [] } : saved;
    addListingAnswers(existing, added);
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
};
