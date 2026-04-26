/**
 * Aggregated statistics for attendees across events.
 */

import { filter, map, reduce } from "#fp";
import type { ActiveEventStats } from "#lib/db/attendee-types.ts";
import { inPlaceholders, queryOne } from "#lib/db/client.ts";
import type { EventWithCount } from "#lib/types.ts";

/**
 * Get aggregated statistics for active events.
 * Filters active events from the provided list, computes attendees
 * (sum of quantities) from cached EventWithCount data, and queries
 * ticket count and income (sum of price_paid) via a single aggregate.
 */
export const getActiveEventStats = async (
  events: EventWithCount[],
): Promise<ActiveEventStats> => {
  const active = filter((e: EventWithCount) => e.active)(events);
  if (active.length === 0) {
    return { attendees: 0, income: 0, tickets: 0 };
  }
  const activeIds = map((e: EventWithCount) => e.id)(active);
  const attendees = reduce(
    (sum: number, e: EventWithCount) => sum + e.attendee_count,
    0,
  )(active);

  const row = (await queryOne<{ tickets: number; income: number }>(
    `SELECT COUNT(*) AS tickets,
            COALESCE(SUM(ea.price_paid), 0) AS income
       FROM event_attendees ea
      WHERE ea.event_id IN (${inPlaceholders(activeIds)})`,
    activeIds,
  ))!;
  return {
    attendees,
    income: row.income,
    tickets: row.tickets,
  };
};
