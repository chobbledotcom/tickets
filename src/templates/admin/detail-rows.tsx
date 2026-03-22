/**
 * Shared detail table rows for admin pages (event, group, calendar)
 */

import { map, pipe, reduce } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import type { Attendee } from "#lib/types.ts";
import type { TableQuestionData } from "#templates/attendee-table.tsx";

/** A key/value row for the event-details-table */
export type DetailRow = {
  key: string;
  value: string;
};

/** Concatenate strings (curried reducer for use in pipe) */
const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** Render an array of DetailRows as <tr><th>…</th><td>…</td></tr> HTML */
export const renderDetailRows = (rows: DetailRow[]): string =>
  pipe(
    map((r: DetailRow) => `<tr><th>${r.key}</th><td>${r.value}</td></tr>`),
    joinStrings,
  )(rows);

/** Count how many people are checked in (summing quantity per registration) */
export const countCheckedIn = (attendees: Attendee[]): number =>
  pipe(
    (list: Attendee[]) => list.filter((a) => a.checked_in),
    reduce((sum: number, a: Attendee) => sum + a.quantity, 0),
  )(attendees);

/** Count how many attendee rows are checked in (ignoring quantity) */
export const countCheckedInRows = (attendees: Attendee[]): number =>
  attendees.filter((a) => a.checked_in).length;

/** Sum the quantity field across a list of attendees */
export const sumQuantity = reduce(
  (sum: number, a: Attendee) => sum + a.quantity,
  0,
);

/** Calculate total revenue in cents from attendees */
export const calculateTotalRevenue = (attendees: Attendee[]): number =>
  reduce(
    (sum: number, a: Attendee) => sum + Number.parseInt(a.price_paid, 10),
    0,
  )(attendees);

/** Count how many times each answer was selected across all attendees */
const countAnswers = (attendeeAnswerMap: Map<number, number[]>) =>
  pipe(
    (m: Map<number, number[]>) => [...m.values()],
    (vals: number[][]) => vals.flat(),
    reduce((counts: Map<number, number>, id: number) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts;
    }, new Map<number, number>()),
  )(attendeeAnswerMap);

/** Format a question's answers as "text (count), ..." */
const formatAnswerParts = (answerCounts: Map<number, number>) =>
  pipe(
    map(
      (a: { id: number; text: string }) =>
        `${a.text} (${answerCounts.get(a.id) ?? 0})`,
    ),
    (parts: string[]) => parts.join(", "),
  );

/** Build answer count summary as DetailRows */
export const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): DetailRow[] => {
  if (!questionData || questionData.questions.length === 0) return [];
  const answerCounts = countAnswers(questionData.attendeeAnswerMap);
  return map(
    (q: {
      text: string;
      answers: { id: number; text: string }[];
    }): DetailRow => ({
      key: q.text,
      value: formatAnswerParts(answerCounts)(q.answers),
    }),
  )(questionData.questions);
};

/** Input for building the shared detail rows shown on group, event, and calendar pages */
export type SharedDetailInput = {
  attendees: Attendee[];
  attendeeCount: number;
  maxCapacity: number;
  hasPaidEvent: boolean;
  questionData?: TableQuestionData;
  labelSuffix?: string;
  /** Skip the attendees row (when the caller renders its own complex version) */
  skipAttendees?: boolean;
};

/** Build the shared detail rows: attendees, checked-in, revenue, question summary */
export const buildSharedDetailRows = ({
  attendees,
  attendeeCount,
  maxCapacity,
  hasPaidEvent,
  questionData,
  labelSuffix = "",
  skipAttendees = false,
}: SharedDetailInput): DetailRow[] => {
  const rows: DetailRow[] = [];

  // Attendees count
  if (!skipAttendees) {
    const countDisplay =
      maxCapacity > 0
        ? `${attendeeCount} / ${maxCapacity}`
        : String(attendeeCount);
    rows.push({ key: `Attendees${labelSuffix}`, value: countDisplay });
  }

  // Checked In
  const quantitySum = sumQuantity(attendees);
  const hasMultiQuantity = quantitySum !== attendees.length;
  const ticketsCheckedIn = countCheckedIn(attendees);
  const checkedInRows = countCheckedInRows(attendees);

  if (hasMultiQuantity) {
    rows.push({
      key: `Tickets Checked In${labelSuffix}`,
      value: `${checkedInRows} / ${attendees.length} &mdash; ${attendees.length - checkedInRows} remain`,
    });
    rows.push({
      key: `Attendees Checked In${labelSuffix}`,
      value: `${ticketsCheckedIn} / ${quantitySum} &mdash; ${quantitySum - ticketsCheckedIn} remain`,
    });
  } else {
    rows.push({
      key: `Checked In${labelSuffix}`,
      value: `${ticketsCheckedIn} / ${quantitySum} &mdash; ${quantitySum - ticketsCheckedIn} remain`,
    });
  }

  // Revenue
  if (hasPaidEvent) {
    rows.push({
      key: "Total Revenue",
      value: formatCurrency(calculateTotalRevenue(attendees)),
    });
  }

  // Question summary
  for (const row of buildAnswerSummaryRows(questionData)) {
    rows.push(row);
  }

  return rows;
};
