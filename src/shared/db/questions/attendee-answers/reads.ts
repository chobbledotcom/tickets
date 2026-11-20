/**
 * Reading attendee answers.
 *
 * Batch and single-attendee reads serve both the choice-only summaries and
 * the owner-key-decrypted free-text table cells.
 */

import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { queryAll, queryAllPrimary } from "#db/client.ts";
import type { ListsByIds } from "#db/query.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { attendeesWithChangedAnswers } from "#db/questions/attendee-answers/at-booking.ts";
import { getQuestionsWithListingIds } from "#db/questions/queries.ts";
import { readRows } from "#db/read.ts";
import { rowsForIds } from "#db/rows-for-ids.ts";
import { equal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlLiteral, sqlName } from "#db/sql.ts";
import { groupToMap, mapParallel } from "#fp";

/** Group `(attendee_id, answer_id)` rows into an attendee → answer-ids map. */
const choiceAnswerMapFromRows = groupToMap(
  (r: { attendee_id: number; answer_id: number }) => r.attendee_id,
  (r) => r.answer_id,
);

/** Load `attendee_answers` rows for a set of attendees, restricted to rows where
 * `column` is set (non-null). The two batch readers (choice ids, decrypted
 * free-text) share this one query. */
const selectAttendeeAnswerRows = <R>(
  attendeeIds: number[],
  column: string,
  selectColumns: SqlStatement,
  join: SqlStatement = sql``,
  readAll: typeof queryAll = queryAll,
): Promise<R[]> =>
  rowsForIds<R>(
    attendeeIds,
    (idSlots) =>
      sql`SELECT ${selectColumns}
       FROM attendee_answers AS attendee_answer
       ${join}
      WHERE ${sqlName(`attendee_answer.${column}`)} IS NOT NULL
        AND attendee_answer.listing_attendee_id IS NULL
        AND attendee_answer.attendee_id IN (${idSlots})`,
    readAll,
  );

/** The choice-id read over the two readers: the shared shape, the caller
 * decides which side of the replication it needs. */
const choiceAnswerIdsWith =
  (readAll: typeof queryAll): ListsByIds =>
  async (attendeeIds) =>
    choiceAnswerMapFromRows(
      await selectAttendeeAnswerRows<{
        attendee_id: number;
        answer_id: number;
      }>(
        attendeeIds,
        "answer_id",
        sql`attendee_answer.attendee_id, attendee_answer.answer_id`,
        sql``,
        readAll,
      ),
    );

const choiceAnswerIdsBatch = choiceAnswerIdsWith(queryAll);

/** Attendee → chosen-answer-ids read pinned to the primary: the registration
 * emails read answers the booking saved earlier in the same request, before a
 * replica can have caught up. */
export const choiceAnswerIdsPrimary = choiceAnswerIdsWith(queryAllPrimary);

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
    sql`SELECT attendee_answer.attendee_id, attendee_answer.answer_id
       FROM attendee_answers AS attendee_answer
      WHERE attendee_answer.answer_id IS NOT NULL
        AND attendee_answer.attendee_id IN (
          SELECT listingAttendee.attendee_id
            FROM listing_attendees AS listingAttendee
            JOIN attendees AS attendee
              ON attendee.id = listingAttendee.attendee_id
           WHERE listingAttendee.listing_id = ${listingId} AND attendee.kind = ${sqlLiteral(ATTENDEE_KIND)})`,
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
    sql`attendee_answer.attendee_id, attendee_answer.question_id, string.encrypted_text`,
    sql`JOIN strings AS string ON string.id = attendee_answer.string_id`,
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
  /** The attendees whose answers changed since booking. Present only when the
   * loader feeds the answers cells, which mark a changed answer. */
  changedAttendeeIds?: ReadonlySet<number>;
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
  if (attendeeIds.length === 0 || listingIds.length === 0) return;
  const [{ questions }, answers, changedAttendeeIds] = await Promise.all([
    getQuestionsWithListingIds(listingIds),
    privateKey
      ? getAttendeeAnswersBatch(attendeeIds, { privateKey, texts: true })
      : getAttendeeAnswersBatch(attendeeIds, { texts: false }),
    attendeesWithChangedAnswers(attendeeIds),
  ]);
  if (questions.length === 0) return;
  // `texts: false` returns a plain choice-answer Map; `texts: true` returns the
  // choice map plus decrypted free-text answers for the table cells.
  return answers instanceof Map
    ? { attendeeAnswerMap: answers, changedAttendeeIds, questions }
    : {
        attendeeAnswerMap: answers.answerIds,
        changedAttendeeIds,
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

/** One answer to a question that asks once for each booked listing. */
export type LineAnswer = {
  listingId: number;
  questionId: number;
  text: string;
};

/** Row shape for a line answer joined onto its booking row and its string. */
type LineAnswerRow = {
  encrypted_text: OwnerKeyEncrypted;
  listing_id: number;
  question_id: number;
};

/** The answers an attendee gave for each booked listing, decrypted for the
 * owner. A listing booked through two paths has one answer for each question,
 * so each pair shows once. */
export const getAttendeeLineAnswers = async (
  attendeeId: number,
  privateKey: () => Promise<CryptoKey>,
): Promise<LineAnswer[]> => {
  const rows = await queryAll<LineAnswerRow>(
    sql`SELECT DISTINCT line.listing_id, attendee_answer.question_id, string.encrypted_text
       FROM attendee_answers AS attendee_answer
       INNER JOIN listing_attendees AS line
         ON line.id = attendee_answer.listing_attendee_id
       INNER JOIN strings AS string ON string.id = attendee_answer.string_id
      WHERE attendee_answer.attendee_id = ${attendeeId}
      ORDER BY attendee_answer.question_id, line.listing_id`,
  );
  if (rows.length === 0) return [];
  const key = await privateKey();
  return mapParallel(
    async (row: LineAnswerRow): Promise<LineAnswer> => ({
      listingId: row.listing_id,
      questionId: row.question_id,
      text: await decryptWithOwnerKey(row.encrypted_text, key),
    }),
  )(rows);
};

/** Get attendee answers mapped by question ID.
 * Returns Map<questionId, { answerId, answerText }> for a single attendee. */
export const getAttendeeAnswersByQuestion = async (
  attendeeId: number,
): Promise<Map<number, { answerId: number; answerText: string }>> => {
  const rows = await readRows(
    from(tables.attendee_answers)
      .join("choice", tables.answers, (given) =>
        equal(given.choice.id, given.answerId),
      )
      .where({ attendeeId })
      .select((given) => ({
        answerId: given.choice.id,
        answerText: given.choice.text,
        questionId: given.choice.questionId,
      })),
  );
  return new Map(
    rows.map(({ answerId, answerText, questionId }) => [
      questionId,
      { answerId, answerText },
    ]),
  );
};
