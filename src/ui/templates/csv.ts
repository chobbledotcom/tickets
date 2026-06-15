/**
 * CSV generation utilities
 */

import { map, pipe, reduce } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Attendee } from "#shared/types.ts";

/** Attendee with associated listing info for calendar CSV */
export type CalendarAttendee = Attendee & {
  listingName: string;
  listingDate: string;
  listingLocation: string;
};

/** Listing-level fields to include in CSV export */
export type CsvListingInfo = {
  listingDate: string;
  listingLocation: string;
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

/** Conditionally include Listing Date and/or Listing Location header columns */
const listingInfoHeaders = (
  showDate: boolean,
  showLocation: boolean,
): string[] => [
  ...(showDate ? ["Listing Date"] : []),
  ...(showLocation ? ["Listing Location"] : []),
];

/** Conditionally include Listing Date and/or Listing Location row values */
const listingInfoCols = (
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
  const domain = getEffectiveDomain();
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
    return escapeCsvValue(matched ? answerTextMap.get(matched)! : "");
  });

/** CSV options for question/answer data */
export type CsvQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/** Format a booking's date for CSV from its stored range: "YYYY-MM-DD" for a
 * single day, "YYYY-MM-DD to YYYY-MM-DD" for multi-day. `endDate` is the
 * exclusive end (the day after the last booked day), so the inclusive last day
 * is `endDate - 1`. Using the per-booking range keeps customisable-days
 * bookings — whose spans vary — correct. */
const csvDateRange = (date: string | null, endDate: string | null): string => {
  if (!date) return "";
  if (!endDate) return date;
  const lastDay = addDays(endDate, -1);
  return lastDay > date ? `${date} to ${lastDay}` : date;
};

/**
 * Generate CSV content from attendees.
 * Always includes both Email and Phone columns regardless of listing settings.
 * When includeDate is true, adds a Date column for daily listings.
 * When listingInfo is provided, adds Listing Date and Listing Location columns.
 * When questionData is provided, adds columns for each custom question.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  listingInfo?: CsvListingInfo,
  questionData?: CsvQuestionData,
): string => {
  const showListingDate = !!listingInfo?.listingDate;
  const showListingLocation = !!listingInfo?.listingLocation;
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
    ...listingInfoHeaders(showListingDate, showListingLocation),
    "Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    ...questionHeaders,
  ];
  return buildCsv(
    headerParts.join(","),
    (a: Attendee, domain) => [
      ...(includeDate
        ? [escapeCsvValue(csvDateRange(a.date, a.end_date))]
        : []),
      ...listingInfoCols(
        showListingDate,
        showListingLocation,
        listingInfo?.listingDate ?? "",
        listingInfo?.listingLocation ?? "",
      ),
      ...attendeeCols(a, domain),
      ...answerCols(a.id, questions, attendeeAnswerMap, answerTextMap),
    ],
    attendees,
  );
};

/**
 * Generate CSV content for calendar view (attendees across multiple daily listings).
 * Conditionally includes Listing Date and Listing Location columns based on data.
 */
export const generateCalendarCsv = (attendees: CalendarAttendee[]): string => {
  const showListingDate = attendees.some((a) => a.listingDate !== "");
  const showListingLocation = attendees.some((a) => a.listingLocation !== "");
  const headerParts = [
    "Listing",
    ...listingInfoHeaders(showListingDate, showListingLocation),
    "Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
  ];
  return buildCsv(
    headerParts.join(","),
    (a: CalendarAttendee, domain) => [
      escapeCsvValue(a.listingName),
      ...listingInfoCols(
        showListingDate,
        showListingLocation,
        a.listingDate,
        a.listingLocation,
      ),
      escapeCsvValue(csvDateRange(a.date, a.end_date)),
      ...attendeeCols(a, domain),
    ],
    attendees,
  );
};
