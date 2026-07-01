/**
 * Shared detail table rows for admin pages (listing, group, calendar)
 */

import { joinStrings, map, reduce, sumOf } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { type Attendee, hasTicketQuantity } from "#shared/types.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";
import type { TableQuestionData } from "#templates/attendee-table.tsx";

/** A key/value row for the listing-details-table */
export type DetailRow = {
  key: string;
  value: string;
};

/** Render an array of DetailRows as <tr><th>…</th><td>…</td></tr> HTML */
export const renderDetailRows = (rows: DetailRow[]): string =>
  joinStrings(
    map((r: DetailRow) => `<tr><th>${r.key}</th><td>${r.value}</td></tr>`)(
      rows,
    ),
  );

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

/** Computed checked-in statistics for an attendee list */
type CheckedInStats = {
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
const getCheckedInStats = (allAttendees: Attendee[]): CheckedInStats => {
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

/** Format "done / total — remaining remain" */
const formatProgress = (done: number, total: number): string =>
  `${done} / ${total} ${t("detail_rows.mdash")} ${total - done} ${t("detail_rows.remain")}`;

/** Build the checked-in detail row(s) — splits into two when multi-quantity */
const buildCheckedInRows = (
  stats: CheckedInStats,
  suffix: string,
): DetailRow[] =>
  stats.hasMultiQuantity
    ? [
        {
          key: `${t("detail_rows.tickets_checked_in")}${suffix}`,
          value: formatProgress(stats.rowsCheckedIn, stats.rowsTotal),
        },
        {
          key: `${t("detail_rows.attendees_checked_in")}${suffix}`,
          value: formatProgress(stats.ticketsCheckedIn, stats.ticketsTotal),
        },
      ]
    : [
        {
          key: `${t("common.checked_in")}${suffix}`,
          value: formatProgress(stats.ticketsCheckedIn, stats.ticketsTotal),
        },
      ];

// ---------------------------------------------------------------------------
// Question answer summary
// ---------------------------------------------------------------------------

/** A question's answer option */
type QuestionAnswer = { id: number; text: string };

/** Count how many times each answer was selected across all attendees */
const countAnswers = (answerMap: Map<number, number[]>): Map<number, number> =>
  reduce((counts: Map<number, number>, ids: number[]) => {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, new Map())([...answerMap.values()]);

/** Format answers as "text (count), text (count), ..." */
const formatAnswerSummary = (
  answers: QuestionAnswer[],
  counts: Map<number, number>,
): string =>
  map((a: QuestionAnswer) => `${a.text} (${counts.get(a.id) ?? 0})`)(
    answers,
  ).join(", ");

/** Build answer count summary as DetailRows */
export const buildAnswerSummaryRows = (
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

/** Whether a count is at or above 90% of capacity */
const isNearCapacity = (count: number, capacity: number): boolean =>
  capacity > 0 && count >= capacity * 0.9;

/** Wrap text in a danger-text span when near capacity */
const wrapDanger = (text: string, danger: boolean): string =>
  danger ? `<span class="danger-text">${text}</span>` : text;

/** Build a single attendee-count detail row, with danger styling near capacity */
const buildAttendeeRow = (
  count: number,
  maxCapacity: number,
  suffix: string,
): DetailRow => {
  const display =
    maxCapacity > 0
      ? `${count} / ${maxCapacity} ${t("detail_rows.mdash")} ${maxCapacity - count} ${t("detail_rows.remain")}`
      : String(count);
  return {
    key: `${t("terms.attendees")}${suffix}`,
    value: wrapDanger(display, isNearCapacity(count, maxCapacity)),
  };
};

/** Build a revenue detail row from a minor-units total */
const buildRevenueRow = (revenue: number): DetailRow => ({
  key: t("detail_rows.total_revenue"),
  value: formatCurrency(revenue),
});

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
  ...buildCheckedInRows(getCheckedInStats(attendees), labelSuffix),
  ...(hasPaidListing
    ? [buildRevenueRow(revenue ?? calculateTotalRevenue(attendees))]
    : []),
  ...buildAnswerSummaryRows(questionData),
];
