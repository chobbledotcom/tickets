/**
 * Ticket form parsing and validation utilities
 */

import { filter, map } from "#fp";
import { validatePrice } from "#lib/currency.ts";
import type {
  QuestionWithAnswers,
  QuestionEventMap,
} from "#lib/db/questions.ts";
import type { EventFields } from "#lib/types.ts";
import {
  errorRedirect,
  formatCreationError,
  htmlResponse,
} from "#routes/utils.ts";
import { extractContact, mergeEventFields } from "#templates/fields.ts";
import { ticketPage, type TicketEvent } from "#templates/public.tsx";
import type { FormParams } from "#lib/form-data.ts";
import type { TicketCtx, EventQty } from "./types.ts";

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
export const formatAtomicError = (
  reason: "capacity_exceeded" | "encryption_error",
  eventName = "",
): string =>
  formatCreationError(
    "Sorry, not enough spots available",
    (name) => `Sorry, ${name} no longer has enough spots available`,
    "Registration failed. Please try again.",
    reason,
    eventName,
  );

/** Parse and validate answers for custom questions from form data.
 * Returns answer IDs if valid, or an error message if any required question is unanswered. */
export const parseQuestionAnswers = (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
): { ok: true; answerIds: number[] } | { ok: false; error: string } => {
  const answerIds: number[] = [];
  for (const q of questions) {
    const raw = form.get(`question_${q.id}`);
    if (!raw) {
      return { ok: false, error: `Please answer: ${q.text}` };
    }
    const answerId = Number.parseInt(raw, 10);
    const validAnswer = q.answers.some((a) => a.id === answerId);
    if (!validAnswer) {
      return { ok: false, error: `Invalid answer for: ${q.text}` };
    }
    answerIds.push(answerId);
  }
  return { ok: true, answerIds };
};

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
  const url = `/ticket/${ctx.slugs.join("+")}`;
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
