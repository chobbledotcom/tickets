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
import type { LineTicket, QuestionWithAnswers } from "#db/question-types.ts";
import { attendeesWithChangedAnswers } from "#db/questions/attendee-answers/at-booking.ts";
import { lineSlotOf } from "#db/questions/line-answers.ts";
import { getQuestionsWithListingIds } from "#db/questions/queries.ts";
import { readRows } from "#db/read.ts";
import { rowsForIds } from "#db/rows-for-ids.ts";
import { equal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import {
  type SqlStatement,
  sql,
  sqlList,
  sqlLiteral,
  sqlName,
} from "#db/sql.ts";
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
        AND attendee_answer.booking_row_id IS NULL
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
  /** attendeeId → the line and ticket answers on the loaded listing, in line
   * and ticket order. The CSV export loads them. */
  lineAnswerMap?: Map<number, LineAnswer[]>;
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

/** Free-text answers keyed by question id, as a list of answers. */
export const textAnswersOf = (
  texts: ReadonlyMap<number, string>,
): { questionId: number; text: string }[] =>
  [...texts].map(([questionId, text]) => ({ questionId, text }));

/** Get free-text answers for one attendee, decrypted for owner/admin edit. */
export const getAttendeeTextAnswers = async (
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<Map<number, string>> =>
  (await getAttendeeTextAnswersBatch([attendeeId], privateKey)).get(
    attendeeId,
  ) ?? new Map();

/** Reads the owner's private key, only when there is something to decrypt. */
type OwnerKeyReader = () => Promise<CryptoKey>;

/** One answer for one ticket of one booking line, with the line's booked
 * quantity. A ticket at or above the quantity is no longer booked. */
export type LineAnswer = LineTicket & {
  /** The date of the booking row that holds the answer. */
  startAt: string | null;
  questionId: number;
  quantity: number;
  text: string;
};

type LineAnswerRow = {
  encrypted_text: OwnerKeyEncrypted;
  id: number;
  listing_id: number;
  package_group_id: number;
  parent_listing_id: number;
  quantity: number;
  question_id: number;
  start_at: string | null;
  unit_index: number;
};

/** The line answers that `where` picks, decrypted for the owner, in the
 * owner's question order, then by line, then by ticket. */
const readLineAnswers = async (
  where: SqlStatement,
  privateKey: OwnerKeyReader,
): Promise<(StoredLineAnswer & { attendeeId: number })[]> => {
  const rows = await queryAll<LineAnswerRow & { attendee_id: number }>(
    sql`SELECT attendee_answer.id, attendee_answer.attendee_id, line.listing_id,
         line.parent_listing_id, line.package_group_id, line.quantity,
         line.start_at, attendee_answer.question_id, attendee_answer.unit_index,
         string.encrypted_text
       FROM attendee_answers AS attendee_answer
       INNER JOIN listing_attendees AS line
         ON line.id = attendee_answer.booking_row_id
       INNER JOIN strings AS string ON string.id = attendee_answer.string_id
       LEFT JOIN questions AS question ON question.id = attendee_answer.question_id
      WHERE ${where}
      ORDER BY question.id IS NULL, question.sort_order,
        attendee_answer.question_id, line.id, attendee_answer.unit_index`,
  );
  if (rows.length === 0) return [];
  const key = await privateKey();
  return mapParallel(async (row: LineAnswerRow & { attendee_id: number }) => ({
    attendeeId: row.attendee_id,
    id: row.id,
    ...lineSlotOf({
      listingId: row.listing_id,
      packageGroupId: row.package_group_id,
      parentListingId: row.parent_listing_id,
    }),
    quantity: row.quantity,
    questionId: row.question_id,
    startAt: row.start_at,
    text: await decryptWithOwnerKey(row.encrypted_text, key),
    unit: row.unit_index,
  }))(rows);
};

/** A line answer and the stored row that holds it. */
type StoredLineAnswer = LineAnswer & { id: number };

/** Which tickets' answers a read takes: every ticket, the tickets that the
 * line still books, or the tickets above the line's quantity. */
export type TicketScope = "all" | "booked" | "hidden";

const TICKET_SCOPES: Record<TicketScope, SqlStatement> = {
  all: sql`TRUE`,
  booked: sql`attendee_answer.unit_index < line.quantity`,
  hidden: sql`attendee_answer.unit_index >= line.quantity`,
};

/** The attendee's answers for each line and ticket in `scope`, decrypted for
 * the owner, in the owner's question order, then by line, then by ticket. */
export const getAttendeeLineAnswers = (
  attendeeId: number,
  privateKey: OwnerKeyReader,
  scope: TicketScope,
): Promise<StoredLineAnswer[]> =>
  readLineAnswers(
    sql`attendee_answer.attendee_id = ${attendeeId} AND ${TICKET_SCOPES[scope]}`,
    privateKey,
  );

/** Each attendee's line answers on these listings, for the CSV. */
export const getLineAnswersOnListings = async (
  attendeeIds: number[],
  listingIds: number[],
  privateKey: CryptoKey,
): Promise<Map<number, LineAnswer[]>> =>
  Map.groupBy(
    await readLineAnswers(
      sql`attendee_answer.attendee_id IN (${sqlList(attendeeIds)})
        AND line.listing_id IN (${sqlList(listingIds)})`,
      () => Promise.resolve(privateKey),
    ),
    ({ attendeeId }) => attendeeId,
  );

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
