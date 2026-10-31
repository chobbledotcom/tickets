/**
 * The answers a booking gave, kept beside the answers as they are now.
 *
 * A booking copies each question it asked, and the answer, into
 * `answers_at_booking`. Admin edits change `attendee_answers` only, so the two
 * compare. The copy holds ciphertext, so the webhook can write it with no key.
 */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { ATTENDEE_BY_TOKEN_SQL } from "#db/attendees/create-batch.ts";
import type { SqlStatement } from "#db/client.ts";
import { rowsByIds } from "#db/query.ts";
import type { BookedAnswer } from "#db/question-types.ts";
import {
  bookedAnswerSaveStatements,
  type PreparedAnswerSave,
} from "#db/questions/attendee-answers/save.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { mapParallel } from "#fp";

/** The questions the booked listings asked, recorded with the answers given.
 * `attendeeSlot` names the attendee in SQL: the standalone save binds the real
 * attendee id; the reservation boundary resolves it from the ticket token the
 * booking batch itself inserts. */
const recordAnswersSql = (
  lineCount: number,
  attendeeSlot: string,
): string => `WITH booked(attendee_id, listing_id) AS (
      VALUES ${Array.from({ length: lineCount }, () => `(${attendeeSlot}, ?)`).join(", ")}
    ), asked AS (
      SELECT DISTINCT booked.attendee_id, question.id AS question_id, question.text
      FROM booked
      INNER JOIN questions AS question
        ON question.assign_all = 1 OR question.id IN (
          SELECT listingQuestion.question_id FROM listing_questions AS listingQuestion
          WHERE listingQuestion.listing_id = booked.listing_id)
      WHERE question.display_type = 'free_text'
        OR EXISTS (SELECT 1 FROM answers AS offered
          WHERE offered.question_id = question.id AND offered.active = 1)
        OR EXISTS (SELECT 1 FROM attendee_answers AS given
          WHERE given.attendee_id = booked.attendee_id AND given.question_id = question.id)
    )
    INSERT INTO answers_at_booking
      (attendee_id, question_id, question_text, answer_id, answer_text, free_text, free_text_index)
    SELECT asked.attendee_id, asked.question_id, asked.text, answer.id, answer.text,
      string.encrypted_text, string.text_index
    FROM asked
    LEFT JOIN attendee_answers AS given
      ON given.attendee_id = asked.attendee_id AND given.question_id = asked.question_id
    LEFT JOIN answers AS answer ON answer.id = given.answer_id
    LEFT JOIN strings AS string ON string.id = given.string_id
    WHERE true
    ON CONFLICT (attendee_id, question_id) DO NOTHING`;

/** The answers-at-booking record: the questions the booked listings asked,
 * and the answer given for each. `attendeeSlot` binds the attendee — a plain
 * `?` for a known id, or the booking batch's own token subselect. */
const recordAnswersStatement = (
  attendeeSlot: string,
  attendeeValue: string | number,
  listingIds: number[],
): SqlStatement => ({
  args: listingIds.flatMap((listingId) => [attendeeValue, listingId]),
  sql: recordAnswersSql(listingIds.length, attendeeSlot),
});

/** The answers a reservation boundary rides with its booking batch: the answer
 * save plus the answers-at-booking record, with the attendee resolved from the
 * batch's own ticket token. The boundary runs these after the booking rows, so
 * a failing answers write rolls the whole reservation back.
 *
 * `listingIds` are the lines the reservation books; `prepared` comes from
 * `prepareAttendeeAnswerSave`, keyed by one placeholder attendee.
 */
export const bookedAnswersTail =
  (
    prepared: PreparedAnswerSave,
    listingIds: number[],
  ): ((tokenIndex: string) => SqlStatement[]) =>
  (tokenIndex) => [
    ...bookedAnswerSaveStatements(prepared, tokenIndex),
    recordAnswersStatement(ATTENDEE_BY_TOKEN_SQL, tokenIndex, listingIds),
  ];

/** The answers-at-booking record for one known attendee, to ride a standalone
 * answer save on a caller's own create transaction. */
export const recordAttendeeAnswersSql = (
  attendeeId: number,
  listingIds: number[],
): SqlStatement => recordAnswersStatement("?", attendeeId, listingIds);

/** Each question that an attendee with a record was asked at booking or
 * answers now, joined to both answers. Only an attendee with a record has
 * rows, so a booking from before the record existed shows no changes. */
const comparedAnswers =
  (columns: string, where: string): ((placeholders: string) => string) =>
  (placeholders) =>
    `WITH recorded AS (
      SELECT DISTINCT attendee_id FROM answers_at_booking
      WHERE attendee_id IN (${placeholders})
    ), pair AS (
      SELECT booked.attendee_id, booked.question_id FROM answers_at_booking AS booked
      INNER JOIN recorded ON recorded.attendee_id = booked.attendee_id
      UNION
      SELECT given.attendee_id, given.question_id FROM attendee_answers AS given
      INNER JOIN recorded ON recorded.attendee_id = given.attendee_id
    )
    SELECT ${columns}
    FROM pair
    LEFT JOIN answers_at_booking AS booked
      ON booked.attendee_id = pair.attendee_id AND booked.question_id = pair.question_id
    LEFT JOIN attendee_answers AS given
      ON given.attendee_id = pair.attendee_id AND given.question_id = pair.question_id
    LEFT JOIN answers AS givenChoice ON givenChoice.id = given.answer_id
    LEFT JOIN answers AS bookedChoice ON bookedChoice.id = booked.answer_id
    LEFT JOIN strings AS givenString ON givenString.id = given.string_id
    LEFT JOIN questions AS question ON question.id = pair.question_id
    ${where}`;

/** An answer counts as changed when the question still exists and its answer
 * is not the one the booking gave. Free text compares by its one-way index. */
const CHANGED = `(question.id IS NOT NULL AND (
    booked.answer_id IS NOT given.answer_id
    OR booked.free_text_index IS NOT givenString.text_index))`;

/** The attendees with at least one answer changed since booking. */
export const attendeesWithChangedAnswers = async (
  attendeeIds: number[],
): Promise<Set<number>> =>
  new Set(
    (
      await rowsByIds<{ attendee_id: number }>(
        attendeeIds,
        comparedAnswers("DISTINCT pair.attendee_id", `WHERE ${CHANGED}`),
      )
    ).map((row) => row.attendee_id),
  );

type ComparedRow = {
  question_id: number;
  question_text: string | null;
  booked_question_text: string | null;
  booked_answer_text: string | null;
  booked_free_text: OwnerKeyEncrypted | null;
  answer_text: string | null;
  free_text: OwnerKeyEncrypted | null;
  changed: number;
  changes_price: number;
};

const orNull = <Stored extends string, T>(
  value: Stored | null,
  read: (value: Stored) => Promise<T>,
): Promise<T | null> => (value === null ? Promise.resolve(null) : read(value));

/** Read one row's `text` column from a questions/answers table. */
const readTextFrom =
  (table: { readColumn: (col: "text", value: string) => Promise<string> }) =>
  (value: string): Promise<string> =>
    table.readColumn("text", value);

const readQuestion = readTextFrom(questionsTable);
const readChoice = readTextFrom(answersTable);

/** One attendee's answers now and at booking, in question order, with the
 * deleted questions last. Empty when the attendee has no record. The key is
 * fetched only when there is free text to read. */
export const getBookedAnswers = async (
  attendeeId: number,
  privateKey: () => Promise<CryptoKey>,
): Promise<BookedAnswer[]> => {
  const readFreeText = async (value: OwnerKeyEncrypted): Promise<string> =>
    decryptWithOwnerKey(value, await privateKey());
  const rows = await rowsByIds<ComparedRow>(
    [attendeeId],
    comparedAnswers(
      `pair.question_id, question.text AS question_text,
      booked.question_text AS booked_question_text,
      booked.answer_text AS booked_answer_text, booked.free_text AS booked_free_text,
      givenChoice.text AS answer_text, givenString.encrypted_text AS free_text,
      ${CHANGED} AS changed,
      (bookedChoice.modifier_id IS NOT NULL OR givenChoice.modifier_id IS NOT NULL) AS changes_price`,
      "ORDER BY question.id IS NULL, question.sort_order, pair.question_id",
    ),
  );
  return mapParallel(
    async (row: ComparedRow): Promise<BookedAnswer> => ({
      answer:
        (await orNull(row.answer_text, readChoice)) ??
        (await orNull(row.free_text, readFreeText)),
      answerAtBooking:
        (await orNull(row.booked_answer_text, readChoice)) ??
        (await orNull(row.booked_free_text, readFreeText)),
      askedAs: await orNull(row.booked_question_text, readQuestion),
      changed: row.changed === 1,
      changesPrice: row.changes_price === 1,
      question: await orNull(row.question_text, readQuestion),
      questionId: row.question_id,
    }),
  )(rows);
};
