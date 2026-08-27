/**
 * Ticket form parsing and validation utilities
 */

import { bookingError } from "#booking/form.ts";
import type { TicketListing } from "#booking/model.ts";
import { quantityFieldName } from "#booking/tree.ts";
import type { AddOnOption } from "#db/modifier-resolve.ts";
import type { TextAnswer } from "#db/question-types.ts";
import type { QuestionListingMap } from "#db/questions/queries.ts";
import { filter, map } from "#fp";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { extractContact } from "#templates/fields/ticket.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import type { ListingQty, TicketCtx } from "./types.ts";

/** Parse and validate a quantity value from a raw string, capping at max */
export const parseQuantityValue = (
  raw: string,
  max: number,
  minDefault = 1,
): number => {
  const quantity = parseNonNegativeInt(raw);
  if (quantity === null || quantity < minDefault) return minDefault;
  return Math.min(quantity, max);
};

/** The answers a submission gave, with the questions and listings they belong
 * to. Built once by `prepareOrder` and read by every answer-handling step. */
export type AnswerInfo = {
  activeQuestions: TicketCtx["questions"];
  answerIds: number[];
  textAnswers: TextAnswer[];
  selectedListingIds: Set<number>;
};

/** Makes a collector that files each (question, value) pair under every
 * selected listing the question applies to — a question assigned to no listing
 * applies to all of them. Buckets are keyed by `String(listingId)`. */
const collectValuesByListing =
  (questionListingMap: QuestionListingMap, selectedListingIds: Set<number>) =>
  <T>(pairs: (readonly [number, T])[]): Record<string, T[]> => {
    const result: Record<string, T[]> = {};
    for (const [questionId, value] of pairs) {
      const listingIds = questionListingMap.get(questionId) ?? [
        ...selectedListingIds,
      ];
      for (const listingId of listingIds) {
        if (!selectedListingIds.has(listingId)) continue;
        const key = String(listingId);
        const list = result[key] ?? [];
        list.push(value);
        result[key] = list;
      }
    }
    return result;
  };

/** Pairs each answered choice question with its chosen answer id. Skips exactly
 * what parseQuestionAnswers skips, so the ids stay aligned: free-text questions
 * (no answer id) and choice questions whose answers are all deactivated (not
 * applicable, so no answer id either). */
const answeredQuestionPairs = (
  info: AnswerInfo,
): (readonly [number, number])[] =>
  info.activeQuestions
    .filter(
      (question) =>
        question.display_type !== "free_text" &&
        question.answers.some((a) => a.active),
    )
    .map((question, index) => [question.id, info.answerIds[index]!] as const);

/** Both per-listing maps a submission's answers reduce to, each keyed by
 * `String(listingId)`. */
export type ListingAnswerMaps = {
  answerIds: Record<string, number[]>;
  textAnswers: Record<string, TextAnswer[]>;
};

/** Files a submission's chosen answer ids and free-text answers under every
 * selected listing their question applies to — the one place both per-listing
 * answer maps are built. */
export const listingAnswerMaps = (
  info: AnswerInfo,
  questionListingMap: QuestionListingMap,
): ListingAnswerMaps => {
  const collect = collectValuesByListing(
    questionListingMap,
    info.selectedListingIds,
  );
  return {
    answerIds: collect(answeredQuestionPairs(info)),
    textAnswers: collect(
      info.textAnswers.map((answer) => [answer.questionId, answer] as const),
    ),
  };
};

/** The outcome of resolving a page's booking date: the chosen date (null when
 * the page offers no dates), or an error when the submitted date isn't offered. */
export type PageDateResolution =
  | { ok: true; date: string | null }
  | { ok: false; error: string };

/** The booking date for a page: null when the page has no dates to choose, the
 * submitted date when it is one the page offers, or an error for anything else. */
export const resolvePageDate = (
  dates: string[],
  submitted: string | null,
): PageDateResolution => {
  if (dates.length === 0) return { date: null, ok: true };
  return submitted && dates.includes(submitted)
    ? { date: submitted, ok: true }
    : { error: bookingError.invalidDate, ok: false };
};

/** Render ticket HTML (CSRF token auto-embedded by CsrfForm) */
export const renderTicketPage = (ctx: TicketCtx, error?: string) =>
  ticketPage({ ...ctx, ...(error !== undefined ? { error } : {}) });

/** Ticket response builder */
export const ticketResponse =
  (ctx: TicketCtx) =>
  (error?: string, status = 200) =>
    htmlResponse(renderTicketPage(ctx, error), status);

/** Ticket form error redirect (PRG). The submitted form is stashed by
 * `redirect()` and re-filled on the follow-up GET — contact fields via
 * renderFields, and the booking controls via their savedFormValue restores —
 * so the visitor keeps everything they entered. */
export const ticketFormErrorResponse = (ctx: TicketCtx) => {
  const url = ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`;
  return (error: string, _status = 400) => errorRedirect(url, error);
};

/** Parse quantity values from ticket form */
export const parseQuantities = (
  form: FormParams,
  listings: TicketListing[],
): Map<number, number> => {
  const quantities = new Map<number, number>();

  for (const { listing, isSoldOut, isClosed, maxPurchasable } of listings) {
    if (isSoldOut || isClosed) continue;

    const raw = form.get(quantityFieldName(listing.id)) || "0";
    const quantity = parseQuantityValue(raw, maxPurchasable, 0);
    if (quantity > 0) {
      quantities.set(listing.id, quantity);
    }
  }

  return quantities;
};

/** Filter listings to those with selected quantity, returning listing and quantity */
export const listingsWithQuantity = (
  listings: TicketListing[],
  quantities: Map<number, number>,
): ListingQty[] => {
  const withQty: ListingQty[] = map(({ listing }: TicketListing) => ({
    listing,
    qty: quantities.get(listing.id) ?? 0,
  }))(listings);
  return filter(({ qty }: ListingQty) => qty > 0)(withQty);
};

/** Parse opt-in add-on selections from the form into a modifier-id → quantity
 * map. Only add-ons offered on the page are read, each clamped to its quantity
 * ceiling; zero or invalid entries are dropped so they don't apply. */
export const parseAddOnSelections = (
  form: FormParams,
  addOns: AddOnOption[],
): Map<number, number> => {
  const selections = new Map<number, number>();
  for (const addOn of addOns) {
    const quantity = parseQuantityValue(
      form.get(`addon_${addOn.id}`) || "0",
      addOn.maxQuantity,
      0,
    );
    if (quantity > 0) selections.set(addOn.id, quantity);
  }
  return selections;
};

export { extractContact };
