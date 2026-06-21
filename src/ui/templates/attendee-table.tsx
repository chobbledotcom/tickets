/**
 * Unified attendee table component — renders attendee lists consistently
 * across the listing detail, check-in, and calendar views.
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

import { flatMap, joinStrings, map, pipe, sort } from "#fp";
import { t } from "#i18n";
import {
  getHeaderText,
  renderCells,
  resolveColumnLayout,
} from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import type {
  Answer,
  AttendeeQuestionData,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { Attendee, AttendeeTableRow } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";

export { formatAddressInline } from "#shared/columns/attendee-columns.ts";
export type { AttendeeTableRow } from "#shared/types.ts";

/** Question data for displaying answers in the attendee table.
 * Canonical shape lives in the questions module; aliased here so existing
 * importers keep their `TableQuestionData` reference. */
export type TableQuestionData = AttendeeQuestionData;

/** Options passed to attendee column cell renderers */
export type AttendeeColumnOpts = {
  allowedDomain: string;
  phonePrefix: string;
  /** Render the status cell (check-in button or refunded badge) */
  renderStatus: (row: AttendeeTableRow) => string;
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
  showListing: boolean;
  showDate: boolean;
  activeFilter?: string;
  returnUrl?: string;
  emptyMessage?: string;
  phonePrefix?: string;
  /** Show the check-in/check-out status column (default: true). Per-attendee
   * edit/refund/delete actions live on the attendee edit page, not the table. */
  showCheckin?: boolean;
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
  const showCheckin = opts.showCheckin !== false;
  return {
    address: rows.some((r) => !!r.attendee.address),
    answers: !!opts.questionData && opts.questionData.questions.length > 0,
    date: opts.showDate,
    email: rows.some((r) => !!r.attendee.email),
    listing: opts.showListing,
    name: true,
    phone: rows.some((r) => !!r.attendee.phone),
    qty: true,
    registered: true,
    special_instructions: rows.some((r) => !!r.attendee.special_instructions),
    status: showCheckin,
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
  const nameCmp = a.listingName.localeCompare(b.listingName);
  if (nameCmp !== 0) return nameCmp;
  const attendeeCmp = a.attendee.name.localeCompare(b.attendee.name);
  if (attendeeCmp !== 0) return attendeeCmp;
  return a.attendee.id - b.attendee.id;
};

/** Sort attendee rows by date, listing name, attendee name, then id */
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
  new Map(
    pipe(
      flatMap((q: QuestionWithAnswers) => q.answers),
      map((a: Answer) => [a.id, a.text] as const),
    )(questions),
  );

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

/** Render the check-in/check-out button form */
const CheckinButton = ({
  a,
  listingId,
  activeFilter,
  returnUrl,
}: {
  a: Attendee;
  listingId: number;
  activeFilter: string;
  returnUrl: string | undefined;
}): string => {
  const isCheckedIn = a.checked_in;
  const label = isCheckedIn
    ? t("admin.attendee_table.check_out")
    : t("admin.attendee_table.check_in");
  const buttonClass = isCheckedIn
    ? "link-button checkout"
    : "link-button checkin";
  return String(
    <CsrfForm
      action={`/admin/listing/${listingId}/attendee/${a.id}/checkin`}
      class="inline"
    >
      <input name="return_filter" type="hidden" value={activeFilter} />
      {returnUrl && <input name="return_url" type="hidden" value={returnUrl} />}
      <button class={buttonClass} type="submit">
        {label}
      </button>
    </CsrfForm>,
  );
};

/** Create the renderStatus callback for column opts */
const createStatusRenderer =
  (opts: AttendeeTableOptions) =>
  (row: AttendeeTableRow): string => {
    // A no-quantity sentinel row stays visible but isn't checkable — show the
    // indicator instead of a check-in button (updateCheckedIn refuses it).
    if (row.attendee.quantity === 0) {
      return String(
        <span class="muted small">
          {t("admin.attendee_table.no_quantity")}
        </span>,
      );
    }
    if (row.attendee.refunded) {
      return String(
        <span class="badge-alert">
          {t("admin.attendee_table.refunded_badge")}
        </span>,
      );
    }
    return CheckinButton({
      a: row.attendee,
      activeFilter: opts.activeFilter ?? "all",
      listingId: row.listingId,
      returnUrl: opts.returnUrl,
    });
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
  `<tr>${renderCells(
    row,
    visibleColumns,
    ATTENDEE_TABLE_COLUMNS,
    colOpts,
    filters,
    escapeHtml,
  )}</tr>`;

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
      : `<tr><td colspan="${colCount}">${
          opts.emptyMessage ?? t("admin.attendee_table.no_attendees")
        }</td></tr>`;

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
