/**
 * The standard attendee columns are shared with the calendar export. This
 * module owns the attendee-specific formatting and the optional date,
 * listing-info, and question columns.
 */

import { isServicing } from "#db/attendees/kind.ts";
import type { AttendeeQuestionData } from "#db/questions/attendee-answers/reads.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { getEffectiveDomain } from "#shared/config.ts";
import { type Column, CSV } from "#shared/csv/index.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { addDays } from "#shared/dates.ts";
import { formatDatetimeShortInTz } from "#shared/timezone.ts";
import { DEFAULT_TIMEZONE } from "#shared/timezone-default.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import type { Attendee } from "#types";
/* jscpd:ignore-end */

/** Listing-level fields optionally prefixed to an attendee export. */
export type CsvListingInfo = {
  listingDate: string;
  listingLocation: string;
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
  const lastDay = addDays(
    parseDateStringOrThrow(endDate, "a stored booking end date"),
    -1,
  );
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
    // The count itself, so a part booking exports 2 and not a bare word.
    value: (a) => String(a.checked_in),
  },
  { header: t("csv.col.ticket_token"), value: (a) => a.ticket_token },
  {
    header: t("csv.col.ticket_url"),
    // Blank for a no-quantity sentinel row: its /t URL renders the attendee's
    // other real bookings (or 404s), so it is not this row's customer ticket.
    // Also blank for a servicing hold: its token route `/t/:token` 404s (kind
    // filter), so the URL is a dead link an operator cannot follow.
    value: (a) =>
      a.quantity === 0 || isServicing(a.kind)
        ? ""
        : `https://${domain}/t/${a.ticket_token}`,
  },
];

/** Optional Listing Date / Listing Location columns, shared by the attendee and
 * calendar exports. The value reads the cell from the row: a per-row listing
 * for the calendar, a fixed listing for a single-listing attendee export. The
 * listing date arrives as a UTC ISO datetime, and the supplied value must
 * render it in the site timezone. */
export const listingInfoColumns = <T>(
  date: { show: boolean; value: Column<T>["value"] },
  location: { show: boolean; value: Column<T>["value"] },
): Column<T>[] => [
  ...(date.show
    ? [{ header: t("csv.col.listing_date"), value: date.value }]
    : []),
  ...(location.show
    ? [{ header: t("csv.col.listing_location"), value: location.value }]
    : []),
];

/** One column per custom question, each cell the attendee's chosen answer (for
 * choice questions) or their decrypted free-text answer (for free_text). */
const questionColumns = (data?: AttendeeQuestionData): Column<Attendee>[] => {
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

type AttendeeCsvOptions = {
  /** Prepend a Date column (the booking's day/range) for daily listings. */
  includeDate: boolean;
  domain: string;
  tz: string;
  /** Prepend fixed Listing Date / Listing Location columns. */
  listingInfo?: CsvListingInfo | undefined;
  questionData?: AttendeeQuestionData | undefined;
};

/** Built per call so the active locale applies. */
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
  ...listingInfoColumns<Attendee>(
    {
      show: Boolean(listingInfo?.listingDate),
      value: () => formatDatetimeShortInTz(listingInfo!.listingDate, tz),
    },
    {
      show: Boolean(listingInfo?.listingLocation),
      value: () => listingInfo!.listingLocation,
    },
  ),
  ...standardAttendeeColumns(domain),
  ...questionColumns(questionData),
];

/**
 * CSV content for one listing's attendees. The Listing Date renders in `tz`.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  listingInfo?: CsvListingInfo,
  questionData?: AttendeeQuestionData,
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
