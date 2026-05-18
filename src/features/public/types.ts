/**
 * Shared types, constants, and tiny utilities for public ticket routes
 */

import type {
  QuestionEventMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { EventWithCount } from "#shared/types.ts";
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
  /** Override the form action and error redirect URL (e.g. `/renew/?t=...`).
   * Defaults to `/ticket/<slugs>` when unset. */
  actionUrl?: string;
  /** When set, threaded into paid/free registration completion so renewals can
   * bump a built site's READ_ONLY_FROM after successful reservation. */
  siteToken?: string;
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
  actionUrl?: string;
  siteToken?: string;
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

/** Set noindex signal header on response; middleware converts it to X-Robots-Tag. */
export const applyNoindex = (response: Response): Response => {
  response.headers.set("x-robots-noindex", "true");
  return response;
};

/** Set noindex signal header on response for hidden events */
export const applyHiddenNoindex = (
  response: Response,
  hidden: boolean,
): Response => (hidden ? applyNoindex(response) : response);
