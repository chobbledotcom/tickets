/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
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
  return (Number.parseInt(pricePaid, 10) / 100).toFixed(2);
};

/** Format checked_in value as Yes/No */
const formatCheckedIn = (checkedIn: string): string =>
  checkedIn === "true" ? "Yes" : "No";

/**
 * Generate CSV content from attendees.
 * Always includes both Email and Phone columns regardless of event settings.
 * When includeDate is true, adds a Date column for daily events.
 */
export const generateAttendeesCsv = (attendees: Attendee[], includeDate = false): string => {
  const domain = getAllowedDomain();
  const header = includeDate
    ? "Date,Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL"
    : "Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL";
  const rows = pipe(
    map((a: Attendee) => {
      const cols = [
        ...(includeDate ? [escapeCsvValue(a.date ?? "")] : []),
        escapeCsvValue(a.name),
        escapeCsvValue(a.email),
        escapeCsvValue(a.phone),
        String(a.quantity),
        escapeCsvValue(new Date(a.created).toISOString()),
        formatPrice(a.price_paid),
        escapeCsvValue(a.payment_id ?? ""),
        formatCheckedIn(a.checked_in),
        escapeCsvValue(a.ticket_token),
        escapeCsvValue(`https://${domain}/t/${a.ticket_token}`),
      ];
      return cols.join(",");
    }),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(attendees);
  return rows;
};
