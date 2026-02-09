/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import type { Attendee } from "#lib/types.ts";

/** Attendee with associated event name for calendar CSV */
export type CalendarAttendee = Attendee & { eventName: string };

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

/** Build standard attendee CSV columns (shared by all CSV generators) */
const attendeeCols = (a: Attendee, domain: string): string[] => [
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

/** Build CSV string from header and row-building function */
const buildCsv = <T>(header: string, toRow: (item: T, domain: string) => string[], items: T[]): string => {
  const domain = getAllowedDomain();
  return pipe(
    map((item: T) => toRow(item, domain).join(",")),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(items);
};

/**
 * Generate CSV content from attendees.
 * Always includes both Email and Phone columns regardless of event settings.
 * When includeDate is true, adds a Date column for daily events.
 */
export const generateAttendeesCsv = (attendees: Attendee[], includeDate = false): string => {
  const header = includeDate
    ? "Date,Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL"
    : "Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL";
  return buildCsv(header, (a: Attendee, domain) => [
    ...(includeDate ? [escapeCsvValue(a.date ?? "")] : []),
    ...attendeeCols(a, domain),
  ], attendees);
};

/** Build calendar row: event name, date, then standard attendee columns */
const calendarRow = (a: CalendarAttendee, domain: string): string[] => [
  escapeCsvValue(a.eventName), escapeCsvValue(a.date ?? ""), ...attendeeCols(a, domain),
];

/**
 * Generate CSV content for calendar view (attendees across multiple daily events).
 * Includes Event name as the first column, followed by Date and standard columns.
 */
export const generateCalendarCsv = (attendees: CalendarAttendee[]): string =>
  buildCsv(
    "Event,Date,Name,Email,Phone,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    calendarRow,
    attendees,
  );
