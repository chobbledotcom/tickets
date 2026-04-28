/**
 * Formatting utilities for dates, errors, and display text
 */

import { nowMs } from "#lib/now.ts";

/** Check if an event's registration period has closed */
export const isRegistrationClosed = (event: {
  closes_at: string | null;
}): boolean =>
  event.closes_at !== null && new Date(event.closes_at).getTime() < nowMs();

/**
 * Build a formatter for capacity-related attendee creation errors.
 * Returns a function `(reason, eventName) => message` that picks one of three
 * messages based on the failure reason and whether an event name is known.
 */
export const capacityErrorFormatter =
  (messages: {
    /** Returned when the failure isn't capacity-related (e.g. encryption_error). */
    fallback: string;
    /** Returned for capacity_exceeded when no event name is available. */
    generic: string;
    /** Returned for capacity_exceeded with a known event name. */
    withName: (name: string) => string;
  }) =>
  (
    reason: "capacity_exceeded" | "encryption_error",
    eventName = "",
  ): string => {
    if (reason !== "capacity_exceeded") return messages.fallback;
    return eventName ? messages.withName(eventName) : messages.generic;
  };

/** Format a countdown from now to a future closes_at date, e.g. "3 days and 5 hours from now" */
export const formatCountdown = (closesAt: string): string => {
  const diffMs = new Date(closesAt).getTime() - nowMs();
  if (diffMs <= 0) return "closed";
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const pl = (n: number, unit: string) => `${n} ${unit}${n !== 1 ? "s" : ""}`;
  if (days > 0 && hours > 0) {
    return `${pl(days, "day")} and ${pl(hours, "hour")} from now`;
  }
  if (days > 0) return `${pl(days, "day")} from now`;
  if (hours > 0) return `${pl(hours, "hour")} from now`;
  return `${pl(
    Math.max(1, Math.floor(diffMs / (1000 * 60))),
    "minute",
  )} from now`;
};
