/**
 * Unified attendee table component — renders attendee lists consistently
 * across the event detail, check-in, and calendar views.
 *
 * Column order is configurable via a Liquid template stored in settings.
 * The template determines which columns appear and in what order.
 * Columns that reference absent data (e.g. email when nobody has one)
 * are still hidden automatically.
 *
 * All cell rendering logic lives in ATTENDEE_TABLE_COLUMNS (single source
 * of truth). This component provides the complex callbacks (status, actions)
 * via the opts object and iterates the ordered column definitions.
 */

import { flatMap, joinStrings, map, pipe, reduce, sort } from "#fp";
import {
  getHeaderText,
  renderCells,
  resolveColumnLayout,
} from "#lib/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#lib/columns/attendee-columns.ts";
import type { Answer, QuestionWithAnswers } from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { Attendee, AttendeeTableRow } from "#lib/types.ts";
import { escapeHtml } from "#templates/layout.tsx";

export { formatAddressInline } from "#lib/columns/attendee-columns.ts";
export type { AttendeeTableRow } from "#lib/types.ts";

/** Question data for displaying answers in the attendee table */
export type TableQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
};

/** Options passed to attendee column cell renderers */
export type AttendeeColumnOpts = {
  allowedDomain: string;
  phonePrefix: string;
  /** Render the status cell (check-in button or refunded badge) */
  renderStatus: (row: AttendeeTableRow) => string;
  /** Render the actions cell (refund, edit, delete, resend links) */
  renderActions: (row: AttendeeTableRow) => string;
  /** Answer maps for question-based columns */
  answerTextMap: Map<number, string>;
  answerQuestionMap: Map<number, string>;
  /** Question data for the answers column */
  questionData?: TableQuestionData;
};

/** Options for the unified AttendeeTable component */
export type AttendeeTableOptions = {
  rows: AttendeeTableRow[];
  allowedDomain: string;
  showEvent: boolean;
  showDate: boolean;
  activeFilter?: string;
  returnUrl?: string;
  emptyMessage?: string;
  phonePrefix?: string;
  /** Show check-in/check-out status and actions columns (default: true) */
  showActions?: boolean;
  /** Skip default sort and use rows as-is (default: false) */
  presorted?: boolean;
  /** Question data for the Answers column */
  questionData?: TableQuestionData;
  /** Liquid template controlling column order (e.g. "{{name}}, {{email}}, {{qty}}") */
  columnTemplate?: string;
};

// ---------------------------------------------------------------------------
// Column visibility — determines which columns are eligible to display
// ---------------------------------------------------------------------------

/** Compute which columns are eligible based on caller options and data */
const computeVisibilityMap = (
  rows: AttendeeTableRow[],
  opts: AttendeeTableOptions,
): Record<string, boolean> => {
  const showActions = opts.showActions !== false;
  return {
    actions: showActions,
    address: rows.some((r) => !!r.attendee.address),
    answers: !!opts.questionData && opts.questionData.questions.length > 0,
    date: opts.showDate,
    email: rows.some((r) => !!r.attendee.email),
    event: opts.showEvent,
    name: true,
    phone: rows.some((r) => !!r.attendee.phone),
    qty: true,
    registered: true,
    special_instructions: rows.some((r) => !!r.attendee.special_instructions),
    status: showActions,
    ticket: true,
  };
};

// ---------------------------------------------------------------------------
// Column ordering — parse template and filter by visibility
// ---------------------------------------------------------------------------

/** Get the ordered list of visible column keys and their filter expressions */
const getColumnLayout = (
  visMap: Record<string, boolean>,
  columnTemplate?: string,
): { visibleColumns: string[]; filters: Map<string, string> } => {
  const template = columnTemplate || settings.attendeeColumnOrder;
  const { columnKeys, filters } = resolveColumnLayout(
    template,
    Object.keys(ATTENDEE_TABLE_COLUMNS),
    ATTENDEE_DEFAULT_ORDER,
  );
  return {
    filters,
    visibleColumns: columnKeys.filter((k) => visMap[k]),
  };
};

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Compare attendee rows for deterministic table ordering */
const compareAttendeeRows = (
  a: AttendeeTableRow,
  b: AttendeeTableRow,
): number => {
  const dateA = a.attendee.date ?? "";
  const dateB = b.attendee.date ?? "";
  if (dateA !== "" || dateB !== "") {
    if (dateA === "") return 1;
    if (dateB === "") return -1;
    const dateCmp = dateA.localeCompare(dateB);
    if (dateCmp !== 0) return dateCmp;
  }
  const nameCmp = a.eventName.localeCompare(b.eventName);
  if (nameCmp !== 0) return nameCmp;
  const attendeeCmp = a.attendee.name.localeCompare(b.attendee.name);
  if (attendeeCmp !== 0) return attendeeCmp;
  return a.attendee.id - b.attendee.id;
};

/** Sort attendee rows by date, event name, attendee name, then id */
export const sortAttendeeRows: (
  rows: AttendeeTableRow[],
) => AttendeeTableRow[] = sort(compareAttendeeRows);

// ---------------------------------------------------------------------------
// Answer helpers
// ---------------------------------------------------------------------------

/** Build answer text map from questions */
const buildAnswerTextMap = (
  questions: QuestionWithAnswers[],
): Map<number, string> =>
  pipe(
    flatMap((q: QuestionWithAnswers) => q.answers),
    reduce((m: Map<number, string>, a: Answer) => {
      m.set(a.id, a.text);
      return m;
    }, new Map()),
  )(questions);

/** Build answer question map (answer ID → question text) */
const buildAnswerQuestionMap = (
  questions: QuestionWithAnswers[],
): Map<number, string> => {
  const m = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) {
      m.set(a.id, q.text);
    }
  }
  return m;
};

// ---------------------------------------------------------------------------
// Status & Actions — complex JSX renderers passed as callbacks
// ---------------------------------------------------------------------------

/** Build a return_url query suffix for action links */
const returnSuffix = (returnUrl: string | undefined): string =>
  returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : "";

/** Render the check-in/check-out button form */
const CheckinButton = ({
  a,
  eventId,
  activeFilter,
  returnUrl,
}: {
  a: Attendee;
  eventId: number;
  activeFilter: string;
  returnUrl: string | undefined;
}): string => {
  const isCheckedIn = a.checked_in;
  const label = isCheckedIn ? "Check out" : "Check in";
  const buttonClass = isCheckedIn
    ? "link-button checkout"
    : "link-button checkin";
  return String(
    <CsrfForm
      action={`/admin/event/${eventId}/attendee/${a.id}/checkin`}
      class="inline"
    >
      <input type="hidden" name="return_filter" value={activeFilter} />
      {returnUrl && <input type="hidden" name="return_url" value={returnUrl} />}
      <button type="submit" class={buttonClass}>
        {label}
      </button>
    </CsrfForm>,
  );
};

/** Check if attendee is eligible for refund (has payment, not yet refunded) */
const isRefundable = (row: AttendeeTableRow): boolean =>
  !!row.attendee.payment_id && !row.attendee.refunded;

/** Create the renderStatus callback for column opts */
const createStatusRenderer =
  (opts: AttendeeTableOptions) =>
  (row: AttendeeTableRow): string => {
    if (row.attendee.refunded) {
      return String(<span class="badge-alert">Refunded</span>);
    }
    return CheckinButton({
      a: row.attendee,
      activeFilter: opts.activeFilter ?? "all",
      eventId: row.eventId,
      returnUrl: opts.returnUrl,
    });
  };

/** Create the renderActions callback for column opts */
const createActionsRenderer =
  (returnUrl: string | undefined) =>
  (row: AttendeeTableRow): string => {
    const a = row.attendee;
    const suffix = returnSuffix(returnUrl);
    return String(
      <>
        {isRefundable(row) && (
          <a
            href={`/admin/event/${row.eventId}/attendee/${a.id}/refund${suffix}`}
            class="danger"
          >
            Refund
          </a>
        )}
        {isRefundable(row) && " "}
        <a href={`/admin/attendees/${a.id}${suffix}`}>Edit</a>{" "}
        <a
          href={`/admin/event/${row.eventId}/attendee/${a.id}/delete${suffix}`}
          class="danger"
        >
          Delete
        </a>{" "}
        <a
          href={`/admin/event/${row.eventId}/attendee/${a.id}/resend-notification${suffix}`}
        >
          Re-send Notification
        </a>
      </>,
    );
  };

// ---------------------------------------------------------------------------
// Row rendering — driven entirely by column generators
// ---------------------------------------------------------------------------

/** Render a single attendee row using ordered column defs */
const AttendeeRow = (
  row: AttendeeTableRow,
  visibleColumns: string[],
  colOpts: AttendeeColumnOpts,
  filters: Map<string, string>,
): string =>
  `<tr>${renderCells(row, visibleColumns, ATTENDEE_TABLE_COLUMNS, colOpts, filters, escapeHtml)}</tr>`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Render the unified attendee table */
export const AttendeeTable = (opts: AttendeeTableOptions): string => {
  const orderedRows = opts.presorted ? opts.rows : sortAttendeeRows(opts.rows);
  const visMap = computeVisibilityMap(orderedRows, opts);
  const { visibleColumns, filters } = getColumnLayout(
    visMap,
    opts.columnTemplate,
  );
  const colCount = visibleColumns.length;

  const hasAnswers = visMap.answers;
  const answerTextMap = hasAnswers
    ? buildAnswerTextMap(opts.questionData!.questions)
    : new Map<number, string>();
  const answerQuestionMap = hasAnswers
    ? buildAnswerQuestionMap(opts.questionData!.questions)
    : new Map<number, string>();

  const colOpts: AttendeeColumnOpts = {
    allowedDomain: opts.allowedDomain,
    answerQuestionMap,
    answerTextMap,
    phonePrefix: opts.phonePrefix || "44",
    questionData: opts.questionData,
    renderActions: createActionsRenderer(opts.returnUrl),
    renderStatus: createStatusRenderer(opts),
  };

  const rows =
    orderedRows.length > 0
      ? pipe(
          map((row: AttendeeTableRow) =>
            AttendeeRow(row, visibleColumns, colOpts, filters),
          ),
          joinStrings,
        )(orderedRows)
      : `<tr><td colspan="${colCount}">${opts.emptyMessage ?? "No attendees yet"}</td></tr>`;

  const headers = pipe(
    map((key: string) => {
      const col = ATTENDEE_TABLE_COLUMNS[key]!;
      const cls = col.headerClassName;
      return `<th${cls ? ` class="${cls}"` : ""}>${getHeaderText(col)}</th>`;
    }),
    joinStrings,
  )(visibleColumns);

  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
};
