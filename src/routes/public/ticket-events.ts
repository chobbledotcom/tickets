/**
 * Build TicketEvent values with group-aware sold-out / maxPurchasable values.
 *
 * Lives outside types.ts so the route modules can keep type-only imports
 * separate from this DB-fetching helper.
 */

import { getGroupRemainingByEventId } from "#lib/db/attendees.ts";
import type { EventWithCount, Group } from "#lib/types.ts";
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

/**
 * Build ticket events for a single known group, computing remaining capacity
 * locally from the events' attendee counts instead of running another query.
 * Skips group-cap clamping for daily-event groups (per-date cap is enforced
 * at booking time, not displayed cumulatively).
 */
export const buildTicketEventsForGroup = (
  group: Group,
  events: EventWithCount[],
): TicketEvent[] => {
  const isDailyGroup = events.some((e) => e.event_type === "daily");
  const groupRemaining =
    group.max_attendees > 0 && !isDailyGroup
      ? Math.max(
          0,
          group.max_attendees -
            events.reduce((sum, e) => sum + e.attendee_count, 0),
        )
      : undefined;
  return events.map((e) =>
    buildTicketEvent(e, isRegistrationClosed(e), groupRemaining),
  );
};
