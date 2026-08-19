/**
 * Shared detail table rows for admin pages (listing, group, calendar)
 */

/* jscpd:ignore-start */
import { map, reduce, sumOf } from "#fp";
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { formatCurrency } from "#shared/currency.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import {
  CapacityMeter,
  capacityLevel,
  capacityMeterText,
} from "#templates/components/capacity.tsx";
import { type Attendee, hasTicketQuantity } from "#types";
/* jscpd:ignore-end */

/** A key/value row for the listing-details-table */
export type DetailRow = {
  key: string;
  value: Child;
};

// ---------------------------------------------------------------------------
// Attendee stats helpers
// ---------------------------------------------------------------------------

/** Sum the quantity field across a list of attendees */
export const sumQuantity = sumOf((a: Attendee) => a.quantity);

/** Count how many people are checked in (summing quantity per registration) */
export const countCheckedIn = (attendees: Attendee[]): number =>
  sumQuantity(attendees.filter((a) => a.checked_in));

/** Count how many attendee rows are checked in (ignoring quantity) */
export const countCheckedInRows = (attendees: Attendee[]): number =>
  attendees.filter((a) => a.checked_in).length;

/** Calculate total revenue in cents from attendees */
export const calculateTotalRevenue = (attendees: Attendee[]): number =>
  sumOf((a: Attendee) => Number.parseInt(a.price_paid, 10))(attendees);

// ---------------------------------------------------------------------------
// Checked-in stats
// ---------------------------------------------------------------------------

/** Computed checked-in statistics for an attendee list. Exported so a caller
 *  that computes these figures in SQL (the Overview tab, which never loads the
 *  attendee rows) can feed {@link buildStatDetailRows} the same shape the
 *  in-memory {@link getCheckedInStats} produces. */
export type CheckedInStats = {
  ticketsCheckedIn: number;
  ticketsTotal: number;
  rowsCheckedIn: number;
  rowsTotal: number;
  hasMultiQuantity: boolean;
};

/** Compute checked-in stats from an attendee list. Only real (quantity > 0)
 * lines count: a no-quantity sentinel row isn't a ticket, so it must not inflate
 * rowsTotal/remaining or force a spurious multi-quantity split (one real + one
 * ghost would otherwise read as 1 ticket across 2 rows). The ghost still shows
 * in the unfiltered admin roster. */
export const getCheckedInStats = (allAttendees: Attendee[]): CheckedInStats => {
  const attendees = allAttendees.filter(hasTicketQuantity);
  const ticketsTotal = sumQuantity(attendees);
  return {
    hasMultiQuantity: ticketsTotal !== attendees.length,
    rowsCheckedIn: countCheckedInRows(attendees),
    rowsTotal: attendees.length,
    ticketsCheckedIn: countCheckedIn(attendees),
    ticketsTotal,
  };
};

/** A progress DetailRow: `${t(labelKey)}${suffix}` keyed to "done / total …". */
const progressRow = (
  labelKey: string,
  suffix: string,
  done: number,
  total: number,
): DetailRow => ({
  key: `${t(labelKey)}${suffix}`,
  value: capacityMeterText(done, total),
});

/** Build the checked-in detail row(s) — splits into two when multi-quantity */
const buildCheckedInRows = (
  stats: CheckedInStats,
  suffix: string,
): DetailRow[] =>
  stats.hasMultiQuantity
    ? [
        progressRow(
          "detail_rows.tickets_checked_in",
          suffix,
          stats.rowsCheckedIn,
          stats.rowsTotal,
        ),
        progressRow(
          "detail_rows.attendees_checked_in",
          suffix,
          stats.ticketsCheckedIn,
          stats.ticketsTotal,
        ),
      ]
    : [
        progressRow(
          "common.checked_in",
          suffix,
          stats.ticketsCheckedIn,
          stats.ticketsTotal,
        ),
      ];

// ---------------------------------------------------------------------------
// Question answer summary
// ---------------------------------------------------------------------------

/** A question's answer option */
type QuestionAnswer = { id: number; text: string };

const answerCount = (counts: Map<number, number>, id: number): number => {
  const count = counts.get(id);
  return count === undefined ? 0 : count;
};

/** Count how many times each answer was selected across all attendees */
const countAnswers = (answerMap: Map<number, number[]>): Map<number, number> =>
  reduce((counts: Map<number, number>, ids: number[]) => {
    for (const id of ids) counts.set(id, answerCount(counts, id) + 1);
    return counts;
  }, new Map())([...answerMap.values()]);

/** Format answers as "text (count), text (count), ..." */
const formatAnswerSummary = (
  answers: QuestionAnswer[],
  counts: Map<number, number>,
): string =>
  map((a: QuestionAnswer) => `${a.text} (${answerCount(counts, a.id)})`)(
    answers,
  ).join(", ");

/** Build answer count summary as DetailRows */
const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): DetailRow[] => {
  if (!questionData || questionData.questions.length === 0) return [];
  const counts = countAnswers(questionData.attendeeAnswerMap);
  return map(
    (q: { text: string; answers: QuestionAnswer[] }): DetailRow => ({
      key: questionTextFlat(q.text),
      value: formatAnswerSummary(q.answers, counts),
    }),
  )(questionData.questions);
};

// ---------------------------------------------------------------------------
// Shared detail rows builder
// ---------------------------------------------------------------------------

/** Input for building the shared detail rows shown on group, listing, and calendar pages */
export type SharedDetailInput = {
  attendees: Attendee[];
  attendeeCount: number;
  maxCapacity: number;
  /** Calculate attendee revenue when no authoritative total is supplied. */
  hasPaidListing: boolean;
  questionData?: TableQuestionData | undefined;
  labelSuffix?: string;
  /** Skip the attendees row (when the caller renders its own complex version) */
  skipAttendees?: boolean;
  /** Total revenue (minor units) to show, when the caller has an authoritative
   * figure that doesn't depend on the loaded attendee rows — the group page
   * passes the ledger-projected income, which still counts revenue from bookings
   * since deleted (an attendee-sum would silently lose it). */
  revenue?: number;
};

/** Build a single attendee-count detail row, with danger styling near capacity */
const buildAttendeeRow = (
  count: number,
  maxCapacity: number,
  suffix: string,
): DetailRow => ({
  key: `${t("terms.attendees")}${suffix}`,
  value:
    maxCapacity > 0
      ? CapacityMeter({
          count,
          danger: capacityLevel(count, maxCapacity).nearLimit,
          max: maxCapacity,
        })
      : String(count),
});

/** Build a revenue detail row from a minor-units total */
const buildRevenueRow = (revenue: number): DetailRow => ({
  key: t("detail_rows.total_revenue"),
  value: formatCurrency(revenue),
});

/** The stat rows shared by the attendee-derived and SQL-derived detail tables:
 *  check-in progress, an optional revenue total, and the answer summary. The
 *  attendee-count row is prepended separately by {@link buildSharedDetailRows},
 *  since a stat-only caller renders its own count. */
export type StatDetailInput = {
  checkedInStats: CheckedInStats;
  /** Received revenue in minor units. Omit this row when no total applies. */
  revenue?: number | undefined;
  questionData?: TableQuestionData | undefined;
  labelSuffix: string;
};

/** Build the check-in / revenue / answer-summary rows from precomputed stats.
 *  Shared so the Overview tab (SQL aggregates) and the roster/group/calendar
 *  pages (in-memory attendee lists) render byte-identical rows. */
export const buildStatDetailRows = ({
  checkedInStats,
  revenue,
  questionData,
  labelSuffix,
}: StatDetailInput): DetailRow[] => [
  ...buildCheckedInRows(checkedInStats, labelSuffix),
  ...(revenue !== undefined ? [buildRevenueRow(revenue)] : []),
  ...buildAnswerSummaryRows(questionData),
];

/** Build the shared detail rows: attendees, checked-in, revenue, question summary */
export const buildSharedDetailRows = ({
  attendees,
  attendeeCount,
  maxCapacity,
  hasPaidListing,
  questionData,
  labelSuffix = "",
  skipAttendees = false,
  revenue,
}: SharedDetailInput): DetailRow[] => [
  ...(skipAttendees
    ? []
    : [buildAttendeeRow(attendeeCount, maxCapacity, labelSuffix)]),
  ...buildStatDetailRows({
    checkedInStats: getCheckedInStats(attendees),
    labelSuffix,
    questionData,
    revenue:
      revenue ??
      (hasPaidListing ? calculateTotalRevenue(attendees) : undefined),
  }),
];
