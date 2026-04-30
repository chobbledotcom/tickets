import { isRegistrationClosed } from "#routes/format.ts";
import { getGroupRemainingByEventId } from "#shared/db/attendees.ts";
import type { EventWithCount } from "#shared/types.ts";
import { buildTicketEvent, type TicketEvent } from "#templates/public.tsx";

export const buildTicketEventsWithGroupCapacity = async (
  events: EventWithCount[],
): Promise<TicketEvent[]> => {
  const groupRemaining = await getGroupRemainingByEventId(events);
  return events.map((e) =>
    buildTicketEvent(e, isRegistrationClosed(e), groupRemaining.get(e.id)),
  );
};
