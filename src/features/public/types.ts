/**
 * Shared types, constants, and tiny utilities for public ticket routes
 */

import { compact, filter, map, pipe } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { EventWithCount } from "#shared/types.ts";
import {
  buildTicketEvent,
  type QrPrefill,
  type TicketEvent,
} from "#templates/public.tsx";

/** Shared rendering context for ticket pages */
export type TicketCtx = {
  slugs: string[];
  events: TicketEvent[];
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
  questionEventMap: QuestionEventMap;
  baseUrl?: string;
  groupName?: string;
  groupDescription?: string;
  qrPrefill?: QrPrefill;
};

/** Possibly-async response handler */
export type AsyncHandler<T extends unknown[]> = (
  ...args: T
) => Response | Promise<Response>;

/** Ticket shared context shape */
export type TicketSharedContext = {
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
  questionEventMap: QuestionEventMap;
  groupName?: string;
  groupDescription?: string;
};

/** Shared context provider for ticket pages */
export type TicketContextProvider = (
  events: TicketEvent[],
) => Promise<TicketSharedContext>;

/** Event with selected quantity */
export type EventQty = { event: EventWithCount; qty: number };

/** Registration closed message for form submissions */
export const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

/** Parse slugs from a slug string (may contain + separator for multiple events) */
export const parseSlugs = (slug: string): string[] =>
  slug.split("+").filter((s) => s.length > 0);

/** Filter and transform events to active ticket events */
export const getActiveEvents = (
  events: (EventWithCount | null)[],
): TicketEvent[] =>
  pipe(
    filter((e: EventWithCount) => e.active),
    map((e: EventWithCount) => buildTicketEvent(e, isRegistrationClosed(e))),
  )(compact(events));

/** Set noindex signal header on response for hidden events */
export const applyHiddenNoindex = (
  response: Response,
  hidden: boolean,
): Response => {
  if (hidden) response.headers.set("x-robots-noindex", "true");
  return response;
};
