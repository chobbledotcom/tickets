/**
 * The answers a booking gave, kept beside the answers as they are now.
 *
 * A booking copies each question it asked, and the answer, into
 * `answers_at_booking`. Admin edits change `attendee_answers` only, so the two
 * compare. The copy holds ciphertext, so the webhook can write it with no key.
 */

import { decryptWithOwnerKey } from "#crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { ATTENDEE_BY_TOKEN_SQL } from "#db/attendees/create-batch.ts";
import type { SqlStatement } from "#db/client.ts";
import { rowsByIds } from "#db/query.ts";
import type { BookedAnswer } from "#db/question-types.ts";
import {
  type AttendeeAnswerSet,
  type AttendeeListingEntry,
  bookedAnswerSaveStatements,
  type PreparedAnswerSave,
  saveAttendeeAnswers,
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

/** Copy every question the booked listings asked, with its saved answer. A
 * choice question counts as asked when it offers an active answer, because
 * the form shows no other. A second copy of a booking changes nothing. */
const recordAnswersAtBooking = (
  lines: readonly AttendeeListingEntry[],
): SqlStatement => ({
  args: lines.flatMap((line) => [line.attendee.id, line.listing.id]),
  sql: recordAnswersSql(lines.length, "?"),
});

/** Save a new booking's answers and record them as the answers at booking,
 * in one write. A booked line with no answers still records its questions. */
export const saveBookedAnswers = (
  lines: readonly AttendeeListingEntry[],
  answers: Map<number, AttendeeAnswerSet>,
): Promise<void> =>
  saveAttendeeAnswers(answers, [recordAnswersAtBooking(lines)]);

/**
 * The answers a reservation boundary rides with its booking batch: the answer
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
    {
      args: listingIds.flatMap((listingId) => [tokenIndex, listingId]),
      sql: recordAnswersSql(listingIds.length, ATTENDEE_BY_TOKEN_SQL),
    },
  ];

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

const readQuestion = (value: string): Promise<string> =>
  questionsTable.readColumn("text", value);
const readChoice = (value: string): Promise<string> =>
  answersTable.readColumn("text", value);

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
