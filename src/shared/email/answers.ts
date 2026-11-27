/**
 * The answers a buyer gave, written the way the email templates show them.
 *
 * Choice answers load from the database by id, so every send path reads them
 * the same way. Free-text answers sit in the strings table sealed to the
 * owner key. They cost a session to read, so the sender passes the texts it
 * already holds. These are the request that took the booking, or the staged
 * copy that the checkout gives back at completion. A line answer shows under
 * the entry of its booking row, named by its line and ticket.
 */

import { getAllGroupNames } from "#db/groups.ts";
import type {
  AnswerRowDate,
  LineTextAnswer,
  LineTicket,
  QuestionWithAnswers,
  TextAnswer,
} from "#db/question-types.ts";
import { choiceAnswerIdsPrimary } from "#db/questions/attendee-answers/reads.ts";
import {
  asksEachLine,
  heldFieldName,
  type LineNames,
  lineLabel,
  listingNamesOf,
  namesWithMissing,
  ticketAnswerName,
  ticketOfFieldOrNull,
} from "#db/questions/line-answers.ts";
import {
  getQuestionsWithListingIds,
  type QuestionListingMap,
} from "#db/questions/queries.ts";
import { compact, filter, requiredMapValue, unique, uniqueBy } from "#fp";
import type { EmailEntry } from "#shared/email.ts";

/** One answered question: the words the buyer saw, and the answer they gave.
 * A line answer in a package also holds its words with the package named in
 * place of the listing. A buyer of a package that hides its members reads
 * those words. */
export type AnswerLine = {
  concealedQuestion?: string;
  question: string;
  text: string;
};

/** Every entry's answer lines, keyed by the booking row the entry stands for. */
export type OrderAnswerLines = Map<string, AnswerLine[]>;

/** The booking row of an entry: its attendee, listing, package and date. Two
 * rows of one listing can differ by package or by date. Each keeps its own
 * answers. */
export const entryKey = ({ attendee, listing }: EmailEntry): string =>
  `${attendee.id}:${listing.id}:${attendee.package_group_id}:${attendee.date ?? ""}`;

/** The free-text answers a sender holds. A booking answer rests under its
 * question id, and a line answer under its ticket field name. */
export type FreeTextAnswers = ReadonlyMap<string, string>;

/** The free-text answers a sender holds, from the booking answers and the
 * line answers it has in plaintext. */
export const heldFreeTexts = (
  textAnswers: readonly TextAnswer[],
  lineAnswers: readonly LineTextAnswer[],
): Map<string, string> =>
  new Map([
    ...textAnswers.map(({ questionId, text }): [string, string] => [
      String(questionId),
      text,
    ]),
    ...lineAnswers.map((answer): [string, string] => [
      heldFieldName(answer.questionId, answer),
      answer.text,
    ]),
  ]);

/** The loaded question and answer context every entry's lines read: the
 * questions the order's listings ask, which listings each one belongs to,
 * each attendee's chosen answer ids, and any free-text answers the sender
 * holds in plaintext. */
export interface QuestionContext {
  chosenByAttendee: ReadonlyMap<number, readonly number[]>;
  freeTexts: FreeTextAnswers;
  names: LineNames;
  questionListingMap: QuestionListingMap;
  questions: readonly QuestionWithAnswers[];
}

/** Whether a question belongs to one listing: a question set to "assign all"
 * asks on every listing, a scoped one only where it was assigned. */
const asksOn = (
  question: QuestionWithAnswers,
  listingId: number,
  questionListingMap: QuestionListingMap,
): boolean =>
  question.assignAll === true ||
  requiredMapValue(questionListingMap, question.id).includes(listingId);

/** The answer text this attendee gave for one question, or null when they
 * left it unanswered: a free-text question reads the held plaintext, a choice
 * question reads the option they picked. A chosen option that was later
 * deactivated still shows, the way the admin edit form keeps a picked-away
 * option. */
const answerTextFor = (
  question: QuestionWithAnswers,
  chosenAnswerIds: readonly number[],
  freeTexts: FreeTextAnswers,
): string | null => {
  if (question.displayType === "free_text") {
    return freeTexts.get(String(question.id)) ?? null;
  }
  const chosen = question.answers.find((answer) =>
    chosenAnswerIds.includes(answer.id),
  );
  return chosen?.text ?? null;
};

/** The answer lines for one (attendee, listing) pair, in the operator's
 * question order, from questions that ask on that listing. */
const linesForEntry = (
  entry: EmailEntry,
  ctx: QuestionContext,
): AnswerLine[] => {
  const chosen = ctx.chosenByAttendee.get(entry.attendee.id) ?? [];
  const asksHere = filter((question: QuestionWithAnswers) =>
    asksOn(question, entry.listing.id, ctx.questionListingMap),
  )(ctx.questions);
  return asksHere.flatMap((question) => {
    if (asksEachLine(question)) return lineAnswersFor(question, entry, ctx);
    const text = answerTextFor(question, chosen, ctx.freeTexts);
    return text === null ? [] : [{ question: question.text, text }];
  });
};

/** Whether a held ticket belongs to this entry's booking row: the same
 * listing, the same package for a row outside a parent, and the same date when
 * the answer names one. An answer typed at checkout names no date. */
const heldOnEntry = (
  { ticket }: { ticket: LineTicket & AnswerRowDate },
  { attendee, listing }: EmailEntry,
): boolean =>
  ticket.listingId === listing.id &&
  (ticket.parentListingId !== 0 ||
    ticket.packageGroupId === attendee.package_group_id) &&
  (ticket.startAt === undefined ||
    (ticket.startAt?.slice(0, 10) ?? null) === attendee.date);

/** The held answers of one line question for the entry's booking row, each
 * named by its line and ticket. */
const lineAnswersFor = (
  question: QuestionWithAnswers,
  entry: EmailEntry,
  { freeTexts, names }: QuestionContext,
): AnswerLine[] =>
  [...freeTexts].flatMap(([key, text]) => {
    const held = ticketOfFieldOrNull(key);
    if (held === null || held.questionId !== question.id) return [];
    if (!heldOnEntry(held, entry)) return [];
    const { package_group_id: packageId } = entry.attendee;
    return [
      {
        ...(packageId === 0
          ? {}
          : {
              concealedQuestion: ticketAnswerName(
                question,
                requiredMapValue(names.packages, packageId),
                held.ticket.unit,
              ),
            }),
        question: ticketAnswerName(
          question,
          lineLabel(held.ticket, names),
          held.ticket.unit,
        ),
        text,
      },
    ];
  });

/** Build every entry's answer lines from loaded questions and choices. Pure:
 * the email renderers can also be fed this shape from a preloaded batch. */
export const orderAnswerLines = (
  entries: readonly EmailEntry[],
  ctx: QuestionContext,
): OrderAnswerLines =>
  new Map(entries.map((entry) => [entryKey(entry), linesForEntry(entry, ctx)]));

/** One entry's answer lines. The loader fills every booking row the entries
 * name, so a miss is broken data, not an unanswered question. */
export const entryAnswerLines =
  (lines: OrderAnswerLines) =>
  (entry: EmailEntry): AnswerLine[] =>
    requiredMapValue(lines, entryKey(entry));

/** The answer as a buyer of a package that hides its members reads it: the
 * package is named, and the member is not. */
export const withoutMemberNames = ({
  concealedQuestion,
  question,
  text,
}: AnswerLine): AnswerLine => ({
  question: concealedQuestion ?? question,
  text,
});

/** Each answer once, first seen first: two package members that ask the same
 * question show it once. */
export const eachAnswerOnce: (lines: AnswerLine[]) => AnswerLine[] = uniqueBy(
  (line: AnswerLine) => `${line.question}\n${line.text}`,
);

/** Load the answer lines for an order's entries in fixed database reads: one
 * for the questions of the booked listings, one for every attendee's chosen
 * answer ids. The choice read is pinned to the primary, because the emails go
 * out in the same request that saved the answers. The cost stays fixed
 * however many lines the order holds. */
export const loadOrderAnswerLines = async (
  entries: readonly EmailEntry[],
  freeTexts: FreeTextAnswers = new Map(),
): Promise<OrderAnswerLines> => {
  const listingIds = unique(entries.map((entry) => entry.listing.id));
  const attendeeIds = unique(entries.map((entry) => entry.attendee.id));
  const heldTickets = compact(
    [...freeTexts.keys()].map((key) => ticketOfFieldOrNull(key)),
  );
  const inPackage =
    heldTickets.length > 0 &&
    (heldTickets.some(({ ticket }) => ticket.packageGroupId !== 0) ||
      entries.some((entry) => entry.attendee.package_group_id !== 0));
  const [{ questions, questionListingMap }, chosen, packages] =
    await Promise.all([
      getQuestionsWithListingIds(listingIds),
      choiceAnswerIdsPrimary(attendeeIds),
      inPackage ? getAllGroupNames() : new Map<number, string>(),
    ]);
  return orderAnswerLines(entries, {
    chosenByAttendee: chosen,
    freeTexts,
    names: {
      listings: namesWithMissing(
        listingNamesOf(entries),
        compact(heldTickets.map(({ ticket }) => ticket.parentListingId)),
      ),
      packages: namesWithMissing(packages, [
        ...heldTickets.map(({ ticket }) => ticket.packageGroupId),
        ...entries.map((entry) => entry.attendee.package_group_id),
      ]),
    },
    questionListingMap,
    questions,
  });
};
