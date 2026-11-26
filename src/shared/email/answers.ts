/**
 * The answers a buyer gave, written the way the email templates show them.
 *
 * Choice answers load from the database by id, so every send path reads them
 * the same way. Free-text answers sit in the strings table sealed to the
 * owner key, which costs a session to read, so the sender passes the texts it
 * already holds: the request that took the booking, or the checkout's staged
 * copy taken back at completion. A line answer shows under the entry of its
 * listing, named by its line and ticket.
 */

import { getAllGroupNames } from "#db/groups.ts";
import type {
  LineTextAnswer,
  QuestionWithAnswers,
  TextAnswer,
} from "#db/question-types.ts";
import { choiceAnswerIdsPrimary } from "#db/questions/attendee-answers/reads.ts";
import {
  asksEachLine,
  type LineNames,
  lineLabel,
  listingNamesOf,
  namesWithMissing,
  ticketAnswerName,
  ticketFieldName,
  ticketOfFieldOrNull,
} from "#db/questions/line-answers.ts";
import {
  getQuestionsWithListingIds,
  type QuestionListingMap,
} from "#db/questions/queries.ts";
import { compact, filter, requiredMapValue, unique, uniqueBy } from "#fp";
import type { EmailEntry } from "#shared/email.ts";

/** One answered question: the words the buyer saw, and the answer they gave. */
export type AnswerLine = { question: string; text: string };

/** Every entry's answer lines, keyed attendee id then listing id. */
export type OrderAnswerLines = Map<number, Map<number, AnswerLine[]>>;

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
      ticketFieldName(answer.questionId, answer),
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

/** The held answers of one line question for the entry's listing, each named
 * by its line and ticket. */
const lineAnswersFor = (
  question: QuestionWithAnswers,
  entry: EmailEntry,
  { freeTexts, names }: QuestionContext,
): AnswerLine[] =>
  [...freeTexts].flatMap(([key, text]) => {
    const held = ticketOfFieldOrNull(key);
    return held === null ||
      held.questionId !== question.id ||
      held.ticket.listingId !== entry.listing.id
      ? []
      : [
          {
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
): OrderAnswerLines => {
  const linesByAttendee = new Map<number, Map<number, AnswerLine[]>>();
  for (const entry of entries) {
    const linesByListing =
      linesByAttendee.get(entry.attendee.id) ?? new Map<number, AnswerLine[]>();
    linesByAttendee.set(entry.attendee.id, linesByListing);
    linesByListing.set(entry.listing.id, linesForEntry(entry, ctx));
  }
  return linesByAttendee;
};

/** One entry's answer lines. The loader fills every (attendee, listing) pair
 * the entries name, so a miss is broken data, not an unanswered question. */
export const entryAnswerLines =
  (lines: OrderAnswerLines) =>
  (entry: EmailEntry): AnswerLine[] =>
    requiredMapValue(
      requiredMapValue(lines, entry.attendee.id),
      entry.listing.id,
    );

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
  const inPackage = heldTickets.some(
    ({ ticket }) => ticket.packageGroupId !== 0,
  );
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
      packages: namesWithMissing(
        packages,
        heldTickets.map(({ ticket }) => ticket.packageGroupId),
      ),
    },
    questionListingMap,
    questions,
  });
};
