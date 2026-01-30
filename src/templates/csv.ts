/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import type { Attendee } from "#lib/types.ts";

/**
 * Escape a value for CSV (handles commas, quotes, newlines)
 */
const escapeCsvValue = (value: string): string => {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

/** Format price in cents as decimal string (e.g. 1000 -> "10.00") */
const formatPrice = (pricePaid: string | null): string => {
  if (pricePaid === null) return "";
  const cents = Number.parseInt(pricePaid, 10);
  if (Number.isNaN(cents)) return "";
  return (cents / 100).toFixed(2);
};

/**
 * Generate CSV content from attendees.
 * Always includes both Email and Phone columns regardless of event settings.
 */
export const generateAttendeesCsv = (attendees: Attendee[]): string => {
  const header = "Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID";
  const rows = pipe(
    map((a: Attendee) =>
      [
        escapeCsvValue(a.name),
        escapeCsvValue(a.email),
        escapeCsvValue(a.phone),
        String(a.quantity),
        escapeCsvValue(new Date(a.created).toISOString()),
        formatPrice(a.price_paid),
        escapeCsvValue(a.payment_id ?? ""),
      ].join(","),
    ),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(attendees);
  return rows;
};
