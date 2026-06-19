/**
 * Column builders shared by the per-listing attendee CSV and the calendar CSV.
 * Both exports start from the same "standard attendee columns" plus the
 * optional listing-info and question columns defined here, so the two
 * generators stay byte-for-byte consistent.
 */

import { map } from "#fp";
import { t } from "#i18n";
import { getEffectiveDomain } from "#shared/config.ts";
import { escapeCsvValue, joinCsvRows } from "#shared/csv/core.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Attendee } from "#shared/types.ts";

/** Listing-level fields to include in CSV export */
export type CsvListingInfo = {
  listingDate: string;
  listingLocation: string;
};

/** CSV options for question/answer data */
export type CsvQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/** Format price in minor units as decimal string using configured currency */
const formatPrice = (pricePaid: string): string =>
  toMajorUnits(Number.parseInt(pricePaid, 10));

/** Format checked_in value as Yes/No */
const formatCheckedIn = (checkedIn: boolean): string =>
  checkedIn ? t("csv.yes") : t("csv.no");

/** Translated, CSV-escaped standard attendee header columns. */
export const attendeeHeaders = (): string[] =>
  [
    t("common.name"),
    t("common.email"),
    t("common.phone"),
    t("common.address"),
    t("common.special_instructions"),
    t("common.quantity"),
    t("common.registered"),
    t("csv.col.price_paid"),
    t("csv.col.transaction_id"),
    t("common.checked_in"),
    t("csv.col.ticket_token"),
    t("csv.col.ticket_url"),
  ].map(escapeCsvValue);

/** Build standard attendee CSV columns (shared by all CSV generators) */
export const attendeeCols = (a: Attendee, domain: string): string[] => [
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
export const listingInfoHeaders = (
  showDate: boolean,
  showLocation: boolean,
): string[] => [
  ...(showDate ? [escapeCsvValue(t("csv.col.listing_date"))] : []),
  ...(showLocation ? [escapeCsvValue(t("csv.col.listing_location"))] : []),
];

/** Conditionally include Listing Date and/or Listing Location row values */
export const listingInfoCols = (
  showDate: boolean,
  showLocation: boolean,
  date: string,
  location: string,
): string[] => [
  ...(showDate ? [escapeCsvValue(date)] : []),
  ...(showLocation ? [escapeCsvValue(location)] : []),
];

/** Build answer columns for an attendee based on questions and answer map */
export const answerCols = (
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

/** Format a booking's date for CSV from its stored range: "YYYY-MM-DD" for a
 * single day, "YYYY-MM-DD to YYYY-MM-DD" for multi-day. `endDate` is the
 * exclusive end (the day after the last booked day), so the inclusive last day
 * is `endDate - 1`. Using the per-booking range keeps customisable-days
 * bookings — whose spans vary — correct. */
export const csvDateRange = (
  date: string | null,
  endDate: string | null,
): string => {
  if (!date) return "";
  if (!endDate) return date;
  const lastDay = addDays(endDate, -1);
  return lastDay > date ? `${date} to ${lastDay}` : date;
};

/** Build CSV string from header and row-building function */
export const buildCsv = <T>(
  header: string,
  toRow: (item: T, domain: string) => string[],
  items: T[],
): string => {
  const domain = getEffectiveDomain();
  return joinCsvRows(
    header,
    map((item: T) => toRow(item, domain).join(","))(items),
  );
};
