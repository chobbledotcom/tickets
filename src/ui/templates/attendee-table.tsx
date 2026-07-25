/**
 * Unified attendee table component — renders attendee lists consistently
 * across the listing detail, check-in, and calendar views.
 *
 * Column order is configurable via a Liquid template stored in settings.
 * The template determines which columns appear and in what order, then this
 * component hides any column whose underlying data is entirely absent in
 * the visible rows (email when nobody has one, phone likewise) so a saved
 * layout never produces a column of blanks. All cell rendering logic lives
 * in `attendeeTable` (single source of truth); this component threads the
 * per-table context (allowed domain, phone prefix, question data, the
 * status cell renderer, etc.) through to those cells.
 */

import { sort } from "#fp";
import { t } from "#i18n";
import { isServicing } from "#shared/db/attendees/kind.ts";
import type { AttendeeQuestionData } from "#shared/db/questions/attendee-answers/reads.ts";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
import {
  type AttendeeColumnOpts,
  attendeeTable,
  buildAnswerMaps,
} from "#shared/tables/attendee-table.tsx";
import type { TableLayout } from "#shared/tables/layout.ts";
import type { AttendeeTableRow, DisplayAttendee } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";
import { renderTable } from "#templates/components/table.tsx";

export type {
  AttendeeColumnOpts,
  TableQuestionData,
} from "#shared/tables/attendee-table.tsx";
export { formatAddressInline } from "#shared/tables/attendee-table.tsx";
export type { AttendeeTableRow } from "#shared/types.ts";

/** Cached/typed attendee-table layout, parsed from the saved setting. */
export type { TableLayout as AttendeeColumnLayout };

/** Options for the unified AttendeeTable component */
export type AttendeeTableOptions = {
  rows: AttendeeTableRow[];
  allowedDomain: string;
  showListing: boolean;
  showDate: boolean;
  activeFilter?: string | undefined;
  returnUrl?: string | undefined;
  emptyMessage?: string | undefined;
  phonePrefix?: string | undefined;
  /** Show the check-in/check-out status column (default: true). Per-attendee
   * edit/refund/delete actions live on the attendee edit page, not the table. */
  showCheckin?: boolean | undefined;
  /** Skip default sort and use rows as-is (default: false) */
  presorted?: boolean | undefined;
  /** Question data for the Answers column */
  questionData?: AttendeeQuestionData | undefined;
  /** Pre-parsed layout controlling column order and filters */
  columnLayout?: TableLayout | undefined;
};

// ---------------------------------------------------------------------------
// Column visibility — determines which columns are eligible to display
// ---------------------------------------------------------------------------

/** Columns hidden when every row's value is blank — keeps a saved layout
 *  from producing a column of empty cells. */
const hideWhenAllBlank = (
  rows: readonly AttendeeTableRow[],
  field: keyof AttendeeTableRow["attendee"],
  columnKey: string,
): Set<string> =>
  rows.some((r) => !!r.attendee[field])
    ? new Set()
    : new Set([columnKey]);

/** Compute which columns should be hidden, based on caller options and the
 *  visible rows: phone/address/special_instructions/answers are hidden when
 *  no attendee has the underlying data, and listings/date/status follow the
 *  caller's `showListing`/`showDate`/`showCheckin` flags. */
const computeHiddenKeys = (
  rows: AttendeeTableRow[],
  opts: AttendeeTableOptions,
): Set<string> => {
  const showCheckin = opts.showCheckin !== false;
  const hidden = new Set<string>();
  if (!showCheckin) hidden.add("status");
  if (!opts.showListing) hidden.add("listings");
  if (!opts.showDate) hidden.add("date");
  for (const columnKey of ["address", "email", "phone", "special_instructions"] as const) {
    const field = columnKey as keyof AttendeeTableRow["attendee"];
    for (const v of hideWhenAllBlank(rows, field, columnKey)) hidden.add(v);
  }
  if (!opts.questionData || opts.questionData.questions.length === 0)
    hidden.add("answers");
  return hidden;
};

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Compare attendee rows for deterministic table ordering */
type AttendeeRowComparator = (
  a: AttendeeTableRow,
  b: AttendeeTableRow,
) => number;

const compareAttendeeDates: AttendeeRowComparator = (a, b) => {
  const dateA = a.attendee.date ?? "";
  const dateB = b.attendee.date ?? "";
  if (dateA === dateB) return 0;
  if (dateA === "") return 1;
  if (dateB === "") return -1;
  return dateA.localeCompare(dateB);
};

const compareTextBy =
  (getText: (row: AttendeeTableRow) => string): AttendeeRowComparator =>
  (a, b) =>
    getText(a).localeCompare(getText(b));

const ATTENDEE_ROW_ORDER: AttendeeRowComparator[] = [
  compareAttendeeDates,
  compareTextBy((row) => row.listings[0]?.name ?? ""),
  compareTextBy((row) => row.attendee.name),
  (a, b) => a.attendee.id - b.attendee.id,
];

const compareAttendeeRows: AttendeeRowComparator = (a, b) => {
  for (const compare of ATTENDEE_ROW_ORDER) {
    const result = compare(a, b);
    if (result !== 0) return result;
  }
  return 0;
};

/** Sort attendee rows by date, listing name, attendee name, then id */
export const sortAttendeeRows: (
  rows: AttendeeTableRow[],
) => AttendeeTableRow[] = sort(compareAttendeeRows);

// ---------------------------------------------------------------------------
// Status rendering — passed to attendeeTable's status column via context
// ---------------------------------------------------------------------------

/** Render the check-in/check-out button form */
const CheckinButton = ({
  a,
  listingId,
  activeFilter,
  returnUrl,
}: {
  a: DisplayAttendee;
  listingId: number;
  activeFilter: string;
  returnUrl: string | undefined;
}): JSX.Element => {
  const isCheckedIn = a.checked_in;
  const label = isCheckedIn
    ? t("admin.attendee_table.check_out")
    : t("admin.attendee_table.check_in");
  const buttonClass = isCheckedIn
    ? "link-button checkout"
    : "link-button checkin";
  return (
    <CsrfForm
      action={`/admin/listing/${listingId}/attendee/${a.id}/checkin`}
      class="inline"
    >
      <input name="return_filter" type="hidden" value={activeFilter} />
      <ReturnUrlField returnUrl={returnUrl} />
      <button class={buttonClass} type="submit">
        {label}
      </button>
    </CsrfForm>
  );
};

/** Build the per-table context the attendee columns need. */
const buildColumnOpts = (opts: AttendeeTableOptions): AttendeeColumnOpts => {
  // Compute visibility map first because:
  //  - the answers column requires `opts.questionData` with at least one
  //    question, so the answer maps are built only when that column will
  //    actually render; an empty questions list (no answers column) means
  //    empty maps that the column never reads.
  const visibleQuestionData =
    opts.questionData && opts.questionData.questions.length > 0
      ? opts.questionData
      : undefined;
  const { answerTextMap, answerQuestionMap } = buildAnswerMaps(
    visibleQuestionData?.questions ?? [],
  );
  return {
    allowedDomain: opts.allowedDomain,
    answerQuestionMap,
    answerTextMap,
    phonePrefix: opts.phonePrefix || "44",
    questionData: visibleQuestionData,
    renderStatus: createStatusRenderer(opts),
  };
};

/** Create the renderStatus callback for column opts */
const createStatusRenderer =
  (opts: AttendeeTableOptions) =>
  (row: AttendeeTableRow): JSX.Element => {
    const a = row.attendee;
    if (isServicing(a.kind)) {
      return (
        <span class="servicing-event" data-servicing="true">
          {t("admin.attendee_table.servicing")}
        </span>
      );
    }
    // A no-quantity sentinel row stays visible but isn't checkable — show an
    // indicator instead of a check-in button (updateCheckedIn refuses it).
    if (!hasTicketQuantity(a)) {
      return (
        <span class="muted small">{t("admin.attendee_table.no_quantity")}</span>
      );
    }
    if (a.refunded) {
      return (
        <span class="muted small">
          {t("admin.attendee_table.refunded_badge")}
        </span>
      );
    }
    // Check-in is a per-booking-line action, and every table that shows it
    // renders one row per line — a one-listing array (grouped browsing tables
    // pass showCheckin: false), so the row's first listing IS the line's.
    return CheckinButton({
      a,
      activeFilter: opts.activeFilter ?? "all",
      listingId: row.listings[0]?.id ?? 0,
      returnUrl: opts.returnUrl,
    });
  };

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Render the unified attendee table. Returns the full
 *  `<div class="table-scroll"><table>` shell. */
export const AttendeeTable = (opts: AttendeeTableOptions): JSX.Element => {
  const rows = opts.presorted ? opts.rows : sortAttendeeRows(opts.rows);
  const hiddenKeys = computeHiddenKeys(rows, opts);
  const layout: TableLayout =
    opts.columnLayout ?? settings.attendeeColumnLayout;
  const colOpts = buildColumnOpts(opts);
  return renderTable(attendeeTable, rows, {
    columnKeys: layout.columnKeys,
    context: colOpts,
    empty: opts.emptyMessage ?? t("admin.attendee_table.no_attendees"),
    filters: layout.filters,
    hiddenKeys,
  });
};
