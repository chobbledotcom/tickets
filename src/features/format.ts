/**
 * Formatting utilities for dates, errors, and display text
 */

import { nowMs } from "#shared/now.ts";

/** Check if an listing's registration period has closed */
export const isRegistrationClosed = (listing: {
  closes_at: string | null;
}): boolean =>
  listing.closes_at !== null && new Date(listing.closes_at).getTime() < nowMs();

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
