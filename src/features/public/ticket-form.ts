/**
 * Ticket form parsing and validation utilities
 */

import { filter, map } from "#fp";
import { capacityErrorFormatter } from "#routes/format.ts";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import { validatePrice } from "#shared/currency.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type {
  AttendeeAnswerSet,
  AttendeeListingEntry,
  QuestionListingMap,
  QuestionWithAnswers,
  TextAnswer,
} from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ListingFields } from "#shared/types.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { extractContact, mergeListingFields } from "#templates/fields.ts";
import { type TicketListing, ticketPage } from "#templates/public.tsx";
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

/** Parse and validate a custom unit price from a form field.
 * Returns the price in minor units, or an error string if invalid. */
export const parseCustomPrice = (
  form: FormParams,
  fieldName: string,
  minPrice: number,
  maxPrice: number,
) => validatePrice(form.getString(fieldName), minPrice, maxPrice);

/** Format error message for failed attendee creation */
export const formatAtomicError = capacityErrorFormatter({
  fallback: "Registration failed. Please try again.",
  generic: "Sorry, not enough spots available",
  withName: (name) => `Sorry, ${name} no longer has enough spots available`,
});

/** Resolve which listings a question applies to: its assigned listings, or
 * every selected listing when the question is assigned to none. */
const listingIdsForQuestion = (
  questionId: number,
  questionListingMap: QuestionListingMap,
  selectedListingIds: Set<number>,
): number[] => questionListingMap.get(questionId) ?? [...selectedListingIds];

/** Append `value` to the per-listing bucket (keyed by `String(listingId)`) of
 * every selected listing the question applies to. */
const pushToListings = <T>(
  result: Record<string, T[]>,
  questionId: number,
  value: T,
  questionListingMap: QuestionListingMap,
  selectedListingIds: Set<number>,
): void => {
  for (const listingId of listingIdsForQuestion(
    questionId,
    questionListingMap,
    selectedListingIds,
  )) {
    if (!selectedListingIds.has(listingId)) continue;
    (result[String(listingId)] ??= []).push(value);
  }
};

/** Build a per-listing answer map from parsed answers and the question-listing
 * mapping. Each listing gets only the answer IDs for questions assigned to it. */
export const buildListingAnswerMap = (
  questions: QuestionWithAnswers[],
  answerIds: number[],
  questionListingMap: QuestionListingMap,
  selectedListingIds: Set<number>,
): Record<string, number[]> => {
  const result: Record<string, number[]> = {};
  let answerIndex = 0;
  for (const question of questions) {
    // Skip exactly what parseQuestionAnswers skips, so answerIds stays aligned:
    // free-text questions (no answer id) and choice questions whose answers are
    // all deactivated (treated as not applicable, so no answer id either).
    if (question.display_type === "free_text") continue;
    if (!question.answers.some((a) => a.active)) continue;
    pushToListings(
      result,
      question.id,
      answerIds[answerIndex++]!,
      questionListingMap,
      selectedListingIds,
    );
  }
  return result;
};

export const buildListingTextAnswerMap = (
  textAnswers: TextAnswer[],
  questionListingMap: QuestionListingMap,
  selectedListingIds: Set<number>,
): Record<string, TextAnswer[]> => {
  const result: Record<string, TextAnswer[]> = {};
  for (const answer of textAnswers) {
    pushToListings(
      result,
      answer.questionId,
      answer,
      questionListingMap,
      selectedListingIds,
    );
  }
  return result;
};

const mergeTextAnswersByQuestion = (
  existing: TextAnswer[] | undefined,
  incoming: TextAnswer[],
): TextAnswer[] => {
  const byQuestion = new Map(
    (existing ?? []).map((answer) => [answer.questionId, answer]),
  );
  for (const answer of incoming) byQuestion.set(answer.questionId, answer);
  return [...byQuestion.values()];
};

export const groupListingAnswerSets = (
  entries: AttendeeListingEntry[],
  listingAnswerIds: Record<string, number[]>,
  listingTextAnswers: Record<string, TextAnswer[]>,
): Map<number, AttendeeAnswerSet> => {
  const answersByAttendee = new Map<number, AttendeeAnswerSet>();
  for (const { attendee, listing } of entries) {
    const key = String(listing.id);
    const answerIds = listingAnswerIds[key] ?? [];
    const textAnswers = listingTextAnswers[key] ?? [];
    if (answerIds.length === 0 && textAnswers.length === 0) continue;
    const existing = answersByAttendee.get(attendee.id) ?? { answerIds: [] };
    existing.answerIds.push(...answerIds);
    if (textAnswers.length > 0) {
      existing.textAnswers = mergeTextAnswersByQuestion(
        existing.textAnswers,
        textAnswers,
      );
    }
    answersByAttendee.set(attendee.id, existing);
  }
  return answersByAttendee;
};

/** Validate submitted date against available dates; returns the date or null if invalid */
export const validateSubmittedDate = (
  form: FormParams,
  dates: string[],
): string | null => {
  const submitted = form.getString("date");
  return submitted && dates.includes(submitted) ? submitted : null;
};

/** Render ticket HTML (CSRF token auto-embedded by CsrfForm) */
export const renderTicketPage = (ctx: TicketCtx, error?: string) =>
  ticketPage({ ...ctx, error });

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

    const raw = form.get(`quantity_${listing.id}`) || "0";
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

/** Determine merged fields setting for selected listings */
export const getTicketFieldsSetting = (
  listings: TicketListing[],
): ListingFields => mergeListingFields(listings.map((e) => e.listing.fields));

export { extractContact };
