/**
 * Unified event sorting — deterministic ordering for all event lists.
 *
 * Tier 0: Standard events with no date → sorted by name
 * Tier 1: Standard events with dates  → sorted by date ASC, then name
 * Tier 2: Daily events                → sorted by next bookable date ASC, then name
 */

import { getNextBookableDate } from "#lib/dates.ts";
import type { Event, Holiday } from "#lib/types.ts";

/** Tier assignment: no-date standard=0, dated standard=1, daily=2 */
const eventTier = (event: Event): number => {
  if (event.event_type === "daily") return 2;
  return event.date === "" ? 0 : 1;
};

/**
 * Create a comparator that uses pre-computed next-bookable-dates for daily events.
 */
const compareEvents =
  (nextDates: Map<number, string | null>) =>
  (a: Event, b: Event): number => {
    const tierA = eventTier(a);
    const tierB = eventTier(b);
    if (tierA !== tierB) return tierA - tierB;

    // Tier 0: no-date standard — sort by name only
    if (tierA === 0) return a.name.localeCompare(b.name);

    // Tier 1: dated standard — sort by date ASC, then name
    if (tierA === 1) {
      const cmp = a.date.localeCompare(b.date);
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    }

    // Tier 2: daily — sort by next bookable date ASC, then name
    const dateA = nextDates.get(a.id) ?? "";
    const dateB = nextDates.get(b.id) ?? "";
    if (dateA === "" && dateB === "") return a.name.localeCompare(b.name);
    if (dateA === "") return 1;
    if (dateB === "") return -1;
    const cmp = dateA.localeCompare(dateB);
    return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
  };

/**
 * Sort events in unified 3-tier order.
 * Works with any Event subtype (Event, EventWithCount, etc.).
 */
export const sortEvents = <T extends Event>(
  events: T[],
  holidays: Holiday[],
): T[] => {
  const nextDates = new Map<number, string | null>();
  for (const event of events) {
    if (event.event_type === "daily") {
      nextDates.set(event.id, getNextBookableDate(event, holidays));
    }
  }
  return [...events].sort(compareEvents(nextDates));
};
