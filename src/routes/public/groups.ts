/**
 * Group ticket context and routing
 */

import { getActiveHolidays } from "#lib/db/holidays.ts";
import {
  computeGroupSlugIndex,
  getActiveEventsByGroupId,
  getGroupBySlugIndex,
} from "#lib/db/groups.ts";
import { getQuestionsWithEventIds } from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
import { sortEvents } from "#lib/sort-events.ts";
import type { Group } from "#lib/types.ts";
import { notFoundResponse } from "#routes/utils.ts";
import type { TicketEvent } from "#templates/public.tsx";
import { computeSharedDates } from "./ticket-payment.ts";
import { handleTicket } from "./ticket-submit.ts";
import {
  getActiveEvents,
  type AsyncHandler,
  type TicketContextProvider,
} from "./types.ts";

/** Context provider for group pages (terms override + shared dates) */
const getGroupTicketContext =
  (group: Group): TicketContextProvider =>
  async (events) => {
    const eventIds = events.map((e) => e.event.id);
    const [dates, globalTerms, questionsResult] = await Promise.all([
      computeSharedDates(events),
      Promise.resolve(settings.terms),
      getQuestionsWithEventIds(eventIds),
    ]);
    const terms = group.terms_and_conditions || globalTerms || "";
    return { dates, terms, ...questionsResult };
  };

/** Load group by slug and its active events, return 404 if empty */
const withActiveGroupEventsBySlug = async (
  slug: string,
  handler: AsyncHandler<[Group, TicketEvent[]]>,
): Promise<Response> => {
  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (!group) return notFoundResponse();

  const [events, holidays] = await Promise.all([
    getActiveEventsByGroupId(group.id),
    getActiveHolidays(),
  ]);
  const activeEvents = getActiveEvents(sortEvents(events, holidays));
  return activeEvents.length === 0
    ? notFoundResponse()
    : handler(group, activeEvents);
};

/** Handle group ticket page by slug */
export const handleGroupTicketBySlug = (
  request: Request,
  slug: string,
): Promise<Response> =>
  withActiveGroupEventsBySlug(slug, (group, activeEvents) =>
    handleTicket(request, [slug], activeEvents, getGroupTicketContext(group)),
  );
