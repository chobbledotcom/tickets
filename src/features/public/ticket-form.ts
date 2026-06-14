/**
 * Ticket form parsing and validation utilities
 */

import { filter, map } from "#fp";
import { capacityErrorFormatter } from "#routes/format.ts";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import { validatePrice } from "#shared/currency.ts";
import {
  type QuestionEventMap,
  type QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { EventFields } from "#shared/types.ts";
import { extractContact, mergeEventFields } from "#templates/fields.ts";
import { type TicketEvent, ticketPage } from "#templates/public.tsx";
import type { EventQty, TicketCtx } from "./types.ts";

/** Parse and validate a quantity value from a raw string, capping at max */
export const parseQuantityValue = (
  raw: string,
  max: number,
  minDefault = 1,
): number => {
  const quantity = Number.parseInt(raw, 10);
  if (Number.isNaN(quantity) || quantity < minDefault) return minDefault;
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

/** Build a per-event answer map from parsed answers and the question-event mapping.
 * Each event gets only the answer IDs for questions assigned to it. */
export const buildEventAnswerMap = (
  questions: QuestionWithAnswers[],
  answerIds: number[],
  questionEventMap: QuestionEventMap,
  selectedEventIds: Set<number>,
): Record<string, number[]> => {
  const result: Record<string, number[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    const answerId = answerIds[i]!;
    // questionEventMap always contains entries for all questions from getQuestionsWithEventIds
    for (const eventId of questionEventMap.get(question.id)!) {
      if (!selectedEventIds.has(eventId)) continue;
      const key = String(eventId);
      (result[key] ??= []).push(answerId);
    }
  }
  return result;
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

/** Ticket form error redirect (after CSRF passed) */
export const ticketFormErrorResponse = (ctx: TicketCtx) => {
  const url = ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`;
  return (error: string, _status = 400) => errorRedirect(url, error);
};

/** Parse quantity values from ticket form */
export const parseQuantities = (
  form: FormParams,
  events: TicketEvent[],
): Map<number, number> => {
  const quantities = new Map<number, number>();

  for (const { event, isSoldOut, isClosed, maxPurchasable } of events) {
    if (isSoldOut || isClosed) continue;

    const raw = form.get(`quantity_${event.id}`) || "0";
    const quantity = parseQuantityValue(raw, maxPurchasable, 0);
    if (quantity > 0) {
      quantities.set(event.id, quantity);
    }
  }

  return quantities;
};

/** Filter events to those with selected quantity, returning event and quantity */
export const eventsWithQuantity = (
  events: TicketEvent[],
  quantities: Map<number, number>,
): EventQty[] => {
  const withQty: EventQty[] = map(({ event }: TicketEvent) => ({
    event,
    qty: quantities.get(event.id) ?? 0,
  }))(events);
  return filter(({ qty }: EventQty) => qty > 0)(withQty);
};

/** Determine merged fields setting for selected events */
export const getTicketFieldsSetting = (events: TicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

export { extractContact };
