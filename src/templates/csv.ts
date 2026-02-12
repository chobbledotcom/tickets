/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import type { Attendee } from "#lib/types.ts";

/** Attendee with associated event info for calendar CSV */
export type CalendarAttendee = Attendee & { eventName: string; eventDate: string; eventLocation: string };

/** Event-level fields to include in CSV export */
export type CsvEventInfo = {
  eventDate: string;
  eventLocation: string;
};

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
  escapeCsvValue(a.address),
  String(a.quantity),
  escapeCsvValue(new Date(a.created).toISOString()),
  formatPrice(a.price_paid),
  escapeCsvValue(a.payment_id ?? ""),
  formatCheckedIn(a.checked_in),
  escapeCsvValue(a.ticket_token),
  escapeCsvValue(`https://${domain}/t/${a.ticket_token}`),
];

/** Conditionally include Event Date and/or Event Location header columns */
const eventInfoHeaders = (showDate: boolean, showLocation: boolean): string[] => [
  ...(showDate ? ["Event Date"] : []),
  ...(showLocation ? ["Event Location"] : []),
];

/** Conditionally include Event Date and/or Event Location row values */
const eventInfoCols = (showDate: boolean, showLocation: boolean, date: string, location: string): string[] => [
  ...(showDate ? [escapeCsvValue(date)] : []),
  ...(showLocation ? [escapeCsvValue(location)] : []),
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
 * When eventInfo is provided, adds Event Date and Event Location columns.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  eventInfo?: CsvEventInfo,
): string => {
  const showEventDate = !!eventInfo?.eventDate;
  const showEventLocation = !!eventInfo?.eventLocation;
  const headerParts = [
    ...(includeDate ? ["Date"] : []),
    ...eventInfoHeaders(showEventDate, showEventLocation),
    "Name,Email,Phone,Address,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
  ];
  return buildCsv(headerParts.join(","), (a: Attendee, domain) => [
    ...(includeDate ? [escapeCsvValue(a.date ?? "")] : []),
    ...eventInfoCols(showEventDate, showEventLocation, eventInfo?.eventDate ?? "", eventInfo?.eventLocation ?? ""),
    ...attendeeCols(a, domain),
  ], attendees);
};

/**
 * Generate CSV content for calendar view (attendees across multiple daily events).
 * Conditionally includes Event Date and Event Location columns based on data.
 */
export const generateCalendarCsv = (attendees: CalendarAttendee[]): string => {
  const showEventDate = attendees.some((a) => a.eventDate !== "");
  const showEventLocation = attendees.some((a) => a.eventLocation !== "");
  const headerParts = [
    "Event",
    ...eventInfoHeaders(showEventDate, showEventLocation),
    "Date,Name,Email,Phone,Address,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
  ];
  return buildCsv(headerParts.join(","), (a: CalendarAttendee, domain) => [
    escapeCsvValue(a.eventName),
    ...eventInfoCols(showEventDate, showEventLocation, a.eventDate, a.eventLocation),
    escapeCsvValue(a.date ?? ""),
    ...attendeeCols(a, domain),
  ], attendees);
};
