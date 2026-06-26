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
import type { AttendeeQuestionData } from "#shared/db/questions.ts";
import { DEFAULT_TIMEZONE, formatDatetimeShortInTz } from "#shared/timezone.ts";
import type { Attendee } from "#shared/types.ts";

/** Listing-level fields optionally prefixed to an attendee export. */
export type CsvListingInfo = {
  listingDate: string;
  listingLocation: string;
};

/** Custom-question data optionally appended to an attendee export. */
export type CsvQuestionData = AttendeeQuestionData;

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
    // Blank for a no-quantity sentinel row: its /t URL renders the attendee's
    // other real bookings (or 404s), so it isn't this row's customer ticket.
    value: (a) =>
      a.quantity === 0 ? "" : `https://${domain}/t/${a.ticket_token}`,
  },
];

/** Optional Listing Date / Listing Location columns (fixed for every row). The
 * listing date is a UTC ISO datetime, shown as a date + time in `tz`. */
const listingInfoColumns = (
  tz: string,
  info?: CsvListingInfo,
): Column<Attendee>[] => [
  ...(info?.listingDate
    ? [
        {
          header: t("csv.col.listing_date"),
          value: () => formatDatetimeShortInTz(info.listingDate, tz),
        },
      ]
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

/** One column per custom question, each cell the attendee's chosen answer (for
 * choice questions) or their decrypted free-text answer (for free_text). */
const questionColumns = (data?: CsvQuestionData): Column<Attendee>[] => {
  const questions = data?.questions ?? [];
  const answerMap = data?.attendeeAnswerMap ?? new Map<number, number[]>();
  const textMap = data?.textAnswerMap;
  const answerText = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) answerText.set(a.id, a.text);
  }
  return questions.map((q) => ({
    header: q.text,
    value: (a: Attendee) => {
      if (q.display_type === "free_text") {
        return textMap?.get(a.id)?.get(q.id) ?? "";
      }
      const ids = answerMap.get(a.id) ?? [];
      const matched = ids.find((id) => q.answers.some((ans) => ans.id === id));
      return matched ? answerText.get(matched)! : "";
    },
  }));
};

/** Options describing which columns an attendee export includes. */
type AttendeeCsvOptions = {
  /** Prepend a Date column (the booking's day/range) for daily listings. */
  includeDate: boolean;
  /** Site domain, for the ticket-URL column. */
  domain: string;
  /** Site timezone, for the optional Listing Date column. */
  tz: string;
  /** Prepend fixed Listing Date / Listing Location columns. */
  listingInfo?: CsvListingInfo;
  /** Append one column per custom question. */
  questionData?: CsvQuestionData;
};

/** The ordered attendee columns for an export: an optional booking Date, then
 * optional listing info, the standard attendee columns, then question columns.
 * Pure — built per call so the active locale applies. */
const attendeeColumns = ({
  includeDate,
  domain,
  tz,
  listingInfo,
  questionData,
}: AttendeeCsvOptions): Column<Attendee>[] => [
  ...(includeDate
    ? [
        {
          header: t("common.date"),
          value: (a: Attendee) => csvDateRange(a.date, a.end_date),
        },
      ]
    : []),
  ...listingInfoColumns(tz, listingInfo),
  ...standardAttendeeColumns(domain),
  ...questionColumns(questionData),
];

/**
 * Generate CSV content for a single listing's attendees. When includeDate is
 * true, prepends a Date column (daily listings); when listingInfo is provided,
 * prepends Listing Date / Listing Location; when questionData is provided,
 * appends one column per custom question. The Listing Date is rendered in `tz`.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  listingInfo?: CsvListingInfo,
  questionData?: CsvQuestionData,
  tz: string = DEFAULT_TIMEZONE,
): string =>
  CSV.generate(
    attendees,
    attendeeColumns({
      domain: getEffectiveDomain(),
      includeDate,
      listingInfo,
      questionData,
      tz,
    }),
  );
