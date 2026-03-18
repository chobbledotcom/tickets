/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { toMajorUnits } from "#lib/currency.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import type { Attendee } from "#lib/types.ts";

/** Attendee with associated event info for calendar CSV */
export type CalendarAttendee = Attendee & {
  eventName: string;
  eventDate: string;
  eventLocation: string;
};

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

/** Format price in minor units as decimal string using configured currency */
const formatPrice = (pricePaid: string): string =>
  toMajorUnits(Number.parseInt(pricePaid, 10));

/** Format checked_in value as Yes/No */
const formatCheckedIn = (checkedIn: boolean): string =>
  checkedIn ? "Yes" : "No";

/** Build standard attendee CSV columns (shared by all CSV generators) */
const attendeeCols = (a: Attendee, domain: string): string[] => [
  escapeCsvValue(a.name),
  escapeCsvValue(a.email),
  escapeCsvValue(a.phone),
  escapeCsvValue(a.address),
  escapeCsvValue(a.special_instructions),
  String(a.quantity),
  escapeCsvValue(new Date(a.created).toISOString()),
  formatPrice(a.price_paid),
  escapeCsvValue(a.payment_id),
  formatCheckedIn(a.checked_in),
  escapeCsvValue(a.ticket_token),
  escapeCsvValue(`https://${domain}/t/${a.ticket_token}`),
];

/** Conditionally include Event Date and/or Event Location header columns */
const eventInfoHeaders = (
  showDate: boolean,
  showLocation: boolean,
): string[] => [
  ...(showDate ? ["Event Date"] : []),
  ...(showLocation ? ["Event Location"] : []),
];

/** Conditionally include Event Date and/or Event Location row values */
const eventInfoCols = (
  showDate: boolean,
  showLocation: boolean,
  date: string,
  location: string,
): string[] => [
  ...(showDate ? [escapeCsvValue(date)] : []),
  ...(showLocation ? [escapeCsvValue(location)] : []),
];

/** Build CSV string from header and row-building function */
const buildCsv = <T>(
  header: string,
  toRow: (item: T, domain: string) => string[],
  items: T[],
): string => {
  const domain = getAllowedDomain();
  return pipe(
    map((item: T) => toRow(item, domain).join(",")),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(items);
};

/** Build answer columns for an attendee based on questions and answer map */
const answerCols = (
  attendeeId: number,
  questions: QuestionWithAnswers[],
  attendeeAnswerMap: Map<number, number[]>,
  answerTextMap: Map<number, string>,
): string[] =>
  questions.map((q) => {
    const answerIds = attendeeAnswerMap.get(attendeeId) ?? [];
    const matched = answerIds.find((aid) =>
      q.answers.some((a) => a.id === aid),
    );
    return escapeCsvValue(matched ? (answerTextMap.get(matched) ?? "") : "");
  });

/** CSV options for question/answer data */
export type CsvQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/**
 * Generate CSV content from attendees.
 * Always includes both Email and Phone columns regardless of event settings.
 * When includeDate is true, adds a Date column for daily events.
 * When eventInfo is provided, adds Event Date and Event Location columns.
 * When questionData is provided, adds columns for each custom question.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  eventInfo?: CsvEventInfo,
  questionData?: CsvQuestionData,
): string => {
  const showEventDate = !!eventInfo?.eventDate;
  const showEventLocation = !!eventInfo?.eventLocation;
  const questions = questionData?.questions ?? [];
  const attendeeAnswerMap = questionData?.attendeeAnswerMap ?? new Map();

  // Build lookup from answer ID to answer text
  const answerTextMap = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) {
      answerTextMap.set(a.id, a.text);
    }
  }

  const questionHeaders = questions.map((q) => escapeCsvValue(q.text));
  const headerParts = [
    ...(includeDate ? ["Date"] : []),
    ...eventInfoHeaders(showEventDate, showEventLocation),
    "Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    ...questionHeaders,
  ];
  return buildCsv(
    headerParts.join(","),
    (a: Attendee, domain) => [
      ...(includeDate ? [escapeCsvValue(a.date ?? "")] : []),
      ...eventInfoCols(
        showEventDate,
        showEventLocation,
        eventInfo?.eventDate ?? "",
        eventInfo?.eventLocation ?? "",
      ),
      ...attendeeCols(a, domain),
      ...answerCols(a.id, questions, attendeeAnswerMap, answerTextMap),
    ],
    attendees,
  );
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
    "Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
  ];
  return buildCsv(
    headerParts.join(","),
    (a: CalendarAttendee, domain) => [
      escapeCsvValue(a.eventName),
      ...eventInfoCols(
        showEventDate,
        showEventLocation,
        a.eventDate,
        a.eventLocation,
      ),
      escapeCsvValue(a.date ?? ""),
      ...attendeeCols(a, domain),
    ],
    attendees,
  );
};
