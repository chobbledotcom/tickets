/**
 * Build TicketEvent values with group-aware sold-out / maxPurchasable values.
 *
 * Lives outside types.ts so the route modules can keep type-only imports
 * separate from this DB-fetching helper.
 */

import { getGroupRemainingByEventId } from "#lib/db/attendees.ts";
import type { EventWithCount } from "#lib/types.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import { buildTicketEvent, type TicketEvent } from "#templates/public.tsx";

/** Build ticket events with group-aware sold-out / maxPurchasable values. */
export const buildTicketEventsWithGroupCapacity = async (
  events: EventWithCount[],
): Promise<TicketEvent[]> => {
  const groupRemaining = await getGroupRemainingByEventId(events);
  return events.map((e) =>
    buildTicketEvent(e, isRegistrationClosed(e), groupRemaining.get(e.id)),
  );
};
