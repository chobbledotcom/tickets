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

/**
 * Generate CSV content from attendees
 */
export const generateAttendeesCsv = (attendees: Attendee[]): string => {
  const header = "Name,Email,Quantity,Registered";
  const rows = pipe(
    map((a: Attendee) =>
      [
        escapeCsvValue(a.name),
        escapeCsvValue(a.email),
        String(a.quantity),
        escapeCsvValue(new Date(a.created).toISOString()),
      ].join(","),
    ),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(attendees);
  return rows;
};
