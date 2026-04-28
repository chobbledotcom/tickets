/**
 * Shared types, constants, and tiny utilities for public ticket routes
 */

import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#lib/db/questions.ts";
import type { EventWithCount } from "#lib/types.ts";
import type { QrPrefill, TicketEvent } from "#templates/public.tsx";

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

/** Set noindex signal header on response for hidden events */
export const applyHiddenNoindex = (
  response: Response,
  hidden: boolean,
): Response => {
  if (hidden) response.headers.set("x-robots-noindex", "true");
  return response;
};
