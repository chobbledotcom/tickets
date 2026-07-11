/**
 * Reading attendee answers.
 *
 * Batch and single-attendee reads serve both the choice-only summaries and
 * the owner-key-decrypted free-text table cells.
 */

import { groupToMap, mapParallel } from "#fp";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { queryAll } from "#shared/db/client.ts";
import { rowsByIds } from "#shared/db/query.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions/queries.ts";
import { answersTable } from "#shared/db/questions/tables.ts";

/** Group `(attendee_id, answer_id)` rows into an attendee → answer-ids map. */
const choiceAnswerMapFromRows = groupToMap(
  (r: { attendee_id: number; answer_id: number }) => r.attendee_id,
  (r) => r.answer_id,
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
  rowsByIds<R>(
    attendeeIds,
    (placeholders) =>
      `SELECT ${selectColumns}
       FROM attendee_answers AS attendee_answer
       ${join}
      WHERE attendee_answer.${column} IS NOT NULL
        AND attendee_answer.attendee_id IN (${placeholders})`,
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
  const textPairsByAttendee = groupToMap(
    (d: (typeof decrypted)[number]) => d.attendeeId,
    (d) => [d.questionId, d.text] as const,
  )(decrypted);
  return new Map(
    [...textPairsByAttendee].map(([attendeeId, pairs]) => [
      attendeeId,
      new Map(pairs),
    ]),
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
