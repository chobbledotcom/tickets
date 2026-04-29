/**
 * Group ticket context and routing
 */

import { notFoundResponse } from "#routes/response.ts";
import {
  computeGroupSlugIndex,
  getActiveEventsByGroupId,
  getGroupBySlugIndex,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { sortEvents } from "#shared/sort-events.ts";
import type { Group } from "#shared/types.ts";
import type { TicketEvent } from "#templates/public.tsx";
import { buildTicketEventsWithGroupCapacity } from "./ticket-events.ts";
import { getTicketContext } from "./ticket-payment.ts";
import { handleTicket } from "./ticket-submit.ts";
import type { AsyncHandler } from "./types.ts";

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
  const activeEvents = await buildTicketEventsWithGroupCapacity(
    sortEvents(events, holidays),
  );
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
    handleTicket(request, [slug], activeEvents, (events) =>
      getTicketContext(events, group),
    ),
  );
