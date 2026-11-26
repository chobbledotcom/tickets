/** Questions that keep their answers on booking lines: one answer for each
 * line, or one for each ticket of a line. */

import type { ChildAllocation, ListingBooking } from "#db/attendee-types.ts";
import { expandChildAllocations } from "#db/attendees/order-parents.ts";
import type {
  AnswerRowDate,
  LineSlot,
  LineTextAnswer,
  LineTicket,
  Question,
  QuestionAnswerLevel,
  QuestionWithAnswers,
} from "#db/question-types.ts";
import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** Whether the question keeps its answers on booking lines: one for each line,
 * or one for each ticket of a line. */
export const asksEachLine = (
  question: Pick<Question, "answerLevel" | "displayType">,
): boolean =>
  question.displayType === "free_text" && question.answerLevel !== "booking";

/** The slot of a booking row. A row under a parent is named by its listing and
 * parent, because one parent gives one row of a child. The package of such a
 * row is left out: the booking stamps it from the parent. */
export const lineSlotOf = (row: {
  listingId: number;
  packageGroupId: number;
  parentListingId?: number | undefined;
}): LineSlot => {
  const parentListingId = row.parentListingId ?? 0;
  return {
    listingId: row.listingId,
    packageGroupId: parentListingId === 0 ? row.packageGroupId : 0,
    parentListingId,
  };
};

/** The slot of a stored booking row. */
export const lineSlotOfRow = (row: {
  listing_id: number;
  package_group_id: number;
  parent_listing_id: number;
}): LineSlot =>
  lineSlotOf({
    listingId: row.listing_id,
    packageGroupId: row.package_group_id,
    parentListingId: row.parent_listing_id,
  });

/** A line slot as one word, the same on the page and on the server. */
export const lineKey = ({
  listingId,
  packageGroupId,
  parentListingId,
}: LineSlot): string => `${listingId}_${parentListingId}_${packageGroupId}`;

/** One answer for each question, ticket and booking row. A row of one slot
 * on another date holds its own answer. */
export const answerKey = (
  questionId: number,
  ticket: LineTicket & AnswerRowDate,
): string =>
  `${questionId}:${lineKey(ticket)}:${ticket.startAt ?? ""}:${ticket.unit}`;

/** The form field that holds the answer to a question for one ticket. */
export const ticketFieldName = (questionId: number, ticket: LineTicket) =>
  `question${questionId}_line${lineKey(ticket)}_ticket${ticket.unit}`;

const TICKET_FIELD = /^question(\d+)_line(\d+)_(\d+)_(\d+)_ticket(\d+)$/u;

/** The question and ticket that a ticket field name names. A held free-text
 * answer rests under the same name. Any other name is not a ticket answer, so
 * it reads as null. */
export const ticketOfFieldOrNull = (
  name: string,
): { questionId: number; ticket: LineTicket } | null => {
  const match = TICKET_FIELD.exec(name);
  if (match === null) return null;
  const [, questionId, listingId, parentListingId, packageGroupId, unit] =
    match.map(Number);
  return {
    questionId: questionId!,
    ticket: {
      listingId: listingId!,
      packageGroupId: packageGroupId!,
      parentListingId: parentListingId!,
      unit: unit!,
    },
  };
};

/** The tickets of a line that a level asks about: unit 0 for each line, or
 * one unit for each ticket of the line's quantity. Every line it is given
 * takes at least one ticket. */
export const unitsAsked = (
  level: QuestionAnswerLevel,
  quantity: number,
): number[] =>
  level === "quantity"
    ? Array.from({ length: quantity }, (_, unit) => unit)
    : [0];

/** A booking line as a question names it: its slot, its booked quantity, and
 * the words a buyer reads for it. */
export type AnswerLine = LineSlot & { label: string; quantity: number };

/** The names that a line's words are made from, by listing and by package. */
export type LineNames = {
  listings: ReadonlyMap<number, string>;
  packages: ReadonlyMap<number, string>;
};

/** The listings, children and packages of one booking page. */
type LinePage = {
  childrenByParentId: ReadonlyMap<
    number,
    readonly { listing: { id: number; name: string } }[]
  >;
  listings: readonly { listing: { id: number; name: string } }[];
  packages: readonly { groupId: number; hideListings: boolean; name: string }[];
};

/** Each listing's name by its id. */
export const listingNamesOf = (
  entries: readonly { listing: { id: number; name: string } }[],
): Map<number, string> =>
  new Map(entries.map(({ listing }) => [listing.id, listing.name]));

/** The names of everything a booking page can book. */
export const pageLineNames = ({
  childrenByParentId,
  listings,
  packages,
}: LinePage): LineNames => ({
  listings: listingNamesOf([
    ...listings,
    ...[...childrenByParentId.values()].flat(),
  ]),
  packages: new Map(packages.map((pkg) => [pkg.groupId, pkg.name])),
});

/** Whether a line rests in a package that hides its members. The buyer never
 * sees such a line, so it owes no answer. */
export const inHiddenPackage = (
  slot: LineSlot,
  packages: LinePage["packages"],
): boolean =>
  packages.some(
    (pkg) => pkg.hideListings && pkg.groupId === slot.packageGroupId,
  );

/** Whether every name that a slot's words need is known. A posted field can
 * name anything, so the submit asks before it builds the words. */
const namesKnown = (slot: LineSlot, { listings, packages }: LineNames) =>
  listings.has(slot.listingId) &&
  (slot.parentListingId === 0 || listings.has(slot.parentListingId)) &&
  (slot.packageGroupId === 0 || packages.has(slot.packageGroupId));

/** The names, with a number for each id that no record holds now. Deleting a
 * parent listing or a package leaves the child bookings and their answers. A
 * missing name reads as its number, as the bookings table shows it. */
export const namesWithMissing = (
  names: ReadonlyMap<number, string>,
  ids: readonly number[],
): Map<number, string> =>
  new Map([
    ...ids
      .filter((id) => id !== 0 && !names.has(id))
      .map((id): [number, string] => [id, `#${id}`]),
    ...names,
  ]);

/** The words a buyer reads for a line: the listing, then its parent or its
 * package when it has one. */
export const lineLabel = (slot: LineSlot, names: LineNames): string => {
  const listing = requiredMapValue(names.listings, slot.listingId);
  if (slot.parentListingId !== 0) {
    return t("questions.line_answer.with_parent", {
      listing,
      parent: requiredMapValue(names.listings, slot.parentListingId),
    });
  }
  return slot.packageGroupId === 0
    ? listing
    : t("questions.line_answer.in_package", {
        listing,
        package: requiredMapValue(names.packages, slot.packageGroupId),
      });
};

/** The words a buyer reads for one answer: the question, then the line, then
 * the ticket when the question asks for each ticket. */
export const ticketAnswerName = (
  question: Pick<Question, "answerLevel" | "text">,
  lineWords: string,
  unit: number,
): string =>
  t("questions.line_answer.name", {
    line:
      question.answerLevel === "quantity"
        ? t("questions.line_answer.ticket", {
            line: lineWords,
            number: unit + 1,
          })
        : lineWords,
    question: question.text,
  });

/** A booking row whose package and quantity are known. */
type LineRow = { packageGroupId: number; quantity: number };

/** The booking lines that an order makes, with their quantities. They come
 * from the same split into rows that the booking itself runs, so each line
 * here is one row that the booking creates. */
export const orderLineQuantities = (
  items: readonly {
    listingId: number;
    packageGroupId?: number | undefined;
    quantity: number;
  }[],
  allocations: ChildAllocation[],
): (LineSlot & { quantity: number })[] => {
  const bookings: (ListingBooking & LineRow)[] = items.map((item) => ({
    listingId: item.listingId,
    packageGroupId: item.packageGroupId ?? 0,
    quantity: item.quantity,
  }));
  return expandChildAllocations(bookings, allocations)
    .filter((row) => row.quantity > 0)
    .map((row) => ({ ...lineSlotOf(row), quantity: row.quantity }));
};

/** The lines a question asks: all, or the ones whose listing is on its list. */
export const linesAskedBy = <Line extends LineSlot>(
  lines: readonly Line[],
  askedListingIds: readonly number[] | undefined,
): Line[] =>
  lines.filter(
    (line) =>
      askedListingIds === undefined || askedListingIds.includes(line.listingId),
  );

/** What an order is asked: its questions, the lines it books, and which
 * listings each question is assigned to. `names` gives the words for any line
 * on the page. */
export type OrderQuestions = {
  lines: readonly AnswerLine[];
  questionListingMap: ReadonlyMap<number, number[]> | undefined;
  questions: readonly QuestionWithAnswers[];
  names: LineNames;
};

/** One answer that the order owes: its question, line and ticket. */
type OwedAnswer = {
  question: QuestionWithAnswers;
  line: AnswerLine;
  unit: number;
};

const answersOwed = ({
  lines,
  questionListingMap,
  questions,
}: OrderQuestions): OwedAnswer[] =>
  questions.filter(asksEachLine).flatMap((question) =>
    linesAskedBy(lines, questionListingMap?.get(question.id)).flatMap((line) =>
      unitsAsked(question.answerLevel, line.quantity).map((unit) => ({
        line,
        question,
        unit,
      })),
    ),
  );

/** Read one owed answer: present, and within the limit. */
const readOwedAnswer = (
  form: URLSearchParams,
  { line, question, unit }: OwedAnswer,
): Result<LineTextAnswer> => {
  const ticket: LineTicket = { ...lineSlotOf(line), unit };
  const text = (form.get(ticketFieldName(question.id, ticket)) ?? "").trim();
  const name = ticketAnswerName(question, line.label, unit);
  if (text.length > MAX_TEXTAREA_LENGTH) {
    return errorResult(t("questions.line_answer.too_long", { name }));
  }
  if (text === "") {
    return errorResult(t("questions.line_answer.missing", { name }));
  }
  return okResult({ ...ticket, questionId: question.id, text });
};

/** The first posted answer that the order does not owe. It can be for a
 * ticket above a line's quantity, a line the order does not book, or a
 * question the order does not ask. A blank field is no answer. */
const unowedAnswerOrNull = (
  form: URLSearchParams,
  asked: OrderQuestions,
  owed: readonly OwedAnswer[],
): string | null => {
  const owedFields = new Set(
    owed.map(({ line, question, unit }) =>
      ticketFieldName(question.id, { ...lineSlotOf(line), unit }),
    ),
  );
  const questionById = new Map(asked.questions.map((q) => [q.id, q]));
  for (const [name, value] of form) {
    if (value.trim() === "" || owedFields.has(name)) continue;
    const posted = ticketOfFieldOrNull(name);
    if (posted === null) continue;
    const question = questionById.get(posted.questionId);
    return t("questions.line_answer.not_booked", {
      name:
        question === undefined || !namesKnown(posted.ticket, asked.names)
          ? name
          : ticketAnswerName(
              question,
              lineLabel(posted.ticket, asked.names),
              posted.ticket.unit,
            ),
    });
  }
  return null;
};

/** Read every answer that the line questions owe. A missing or too long answer
 * stops the booking, and so does an answer for anything the order does not
 * book. */
export const parseLineTextAnswers = (
  form: URLSearchParams,
  asked: OrderQuestions,
): Result<LineTextAnswer[]> => {
  const owed = answersOwed(asked);
  const lineTextAnswers: LineTextAnswer[] = [];
  for (const answer of owed) {
    const read = readOwedAnswer(form, answer);
    if (!read.ok) return read;
    lineTextAnswers.push(read.value);
  }
  const unowed = unowedAnswerOrNull(form, asked, owed);
  return unowed === null ? okResult(lineTextAnswers) : errorResult(unowed);
};
