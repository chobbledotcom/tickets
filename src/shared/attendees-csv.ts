/**
 * Attendee CSV columns and the per-listing attendee export. The standard
 * attendee columns are shared with the calendar export; this module owns the
 * attendee-specific formatting and assembles the optional date / listing-info /
 * question columns. Everything is expressed as {@link Column}s and handed to the
 * pure {@link CSV.generate}.
 */

import { t } from "#i18n";
import { getEffectiveDomain } from "#shared/config.ts";
import { type Column, CSV } from "#shared/csv/index.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Attendee } from "#shared/types.ts";

/** Listing-level fields optionally prefixed to an attendee export. */
export type CsvListingInfo = {
  listingDate: string;
  listingLocation: string;
};

/** Custom-question data optionally appended to an attendee export. */
export type CsvQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/** Price in minor units as a decimal string in the configured currency. */
const formatPrice = (pricePaid: string): string =>
  toMajorUnits(Number.parseInt(pricePaid, 10));

/**
 * A booking's date for CSV from its stored range: "YYYY-MM-DD" for a single
 * day, "YYYY-MM-DD to YYYY-MM-DD" for multi-day. `endDate` is the exclusive end
 * (the day after the last booked day), so the inclusive last day is
 * `endDate - 1`. Using the per-booking range keeps customisable-days bookings —
 * whose spans vary — correct.
 */
export const csvDateRange = (
  date: string | null,
  endDate: string | null,
): string => {
  if (!date) return "";
  if (!endDate) return date;
  const lastDay = addDays(endDate, -1);
  return lastDay > date ? `${date} to ${lastDay}` : date;
};

/** The standard attendee columns, shared by every attendee-based export. */
export const standardAttendeeColumns = (domain: string): Column<Attendee>[] => [
  { header: t("common.name"), value: (a) => a.name },
  { header: t("common.email"), value: (a) => a.email },
  { header: t("common.phone"), value: (a) => a.phone },
  { header: t("common.address"), value: (a) => a.address },
  {
    header: t("common.special_instructions"),
    value: (a) => a.special_instructions,
  },
  { header: t("common.quantity"), value: (a) => String(a.quantity) },
  {
    header: t("common.registered"),
    value: (a) => new Date(a.created).toISOString(),
  },
  { header: t("csv.col.price_paid"), value: (a) => formatPrice(a.price_paid) },
  { header: t("csv.col.transaction_id"), value: (a) => a.payment_id },
  {
    header: t("common.checked_in"),
    value: (a) => (a.checked_in ? t("csv.yes") : t("csv.no")),
  },
  { header: t("csv.col.ticket_token"), value: (a) => a.ticket_token },
  {
    header: t("csv.col.ticket_url"),
    value: (a) => `https://${domain}/t/${a.ticket_token}`,
  },
];

/** Optional Listing Date / Listing Location columns (fixed for every row). */
const listingInfoColumns = (info?: CsvListingInfo): Column<Attendee>[] => [
  ...(info?.listingDate
    ? [{ header: t("csv.col.listing_date"), value: () => info.listingDate }]
    : []),
  ...(info?.listingLocation
    ? [
        {
          header: t("csv.col.listing_location"),
          value: () => info.listingLocation,
        },
      ]
    : []),
];

/** One column per custom question, each cell the attendee's chosen answer. */
const questionColumns = (data?: CsvQuestionData): Column<Attendee>[] => {
  const questions = data?.questions ?? [];
  const answerMap = data?.attendeeAnswerMap ?? new Map<number, number[]>();
  const answerText = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) answerText.set(a.id, a.text);
  }
  return questions.map((q) => ({
    header: q.text,
    value: (a: Attendee) => {
      const ids = answerMap.get(a.id) ?? [];
      const matched = ids.find((id) => q.answers.some((ans) => ans.id === id));
      return matched ? answerText.get(matched)! : "";
    },
  }));
};

/**
 * Generate CSV content for a single listing's attendees. When includeDate is
 * true, prepends a Date column (daily listings); when listingInfo is provided,
 * prepends Listing Date / Listing Location; when questionData is provided,
 * appends one column per custom question.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  listingInfo?: CsvListingInfo,
  questionData?: CsvQuestionData,
): string =>
  CSV.generate(attendees, [
    ...(includeDate
      ? [
          {
            header: t("common.date"),
            value: (a: Attendee) => csvDateRange(a.date, a.end_date),
          },
        ]
      : []),
    ...listingInfoColumns(listingInfo),
    ...standardAttendeeColumns(getEffectiveDomain()),
    ...questionColumns(questionData),
  ]);
