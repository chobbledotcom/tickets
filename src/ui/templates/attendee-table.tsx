/**
 * The unified attendee table — columns, cell renderers, sorting, and the
 * `AttendeeTable` composition component, all in one place. Rendered across
 * the listing detail, check-in, and calendar views.
 *
 * Column order is configurable via a Liquid template stored in settings.
 * The template determines which columns appear and in what order, then
 * `AttendeeTable` hides any column whose underlying data is entirely absent
 * in the visible rows (email when nobody has one, phone likewise) so a saved
 * layout never produces a column of blanks.
 *
 * The pure layout metadata (column keys, default order, layout parser) lives
 * in `#shared/tables/attendee-layout.ts` so `settings.ts` can parse a saved
 * template without importing this UI module.
 */

import { sort } from "#fp";
import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { AttendeeQuestionData } from "#shared/db/questions/attendee-answers/reads.ts";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { nonBlankLines } from "#shared/lines.ts";
import { normalizePhone } from "#shared/phone.ts";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
import { ATTENDEE_COLUMN_KEYS } from "#shared/tables/attendee-layout.ts";
import { defineTable, type TableColumn } from "#shared/tables/definition.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import type { AttendeeTableRow, DisplayAttendee } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";
import { renderTable } from "#templates/components/table.tsx";

export type { AttendeeTableRow } from "#shared/types.ts";
export type { TableLayout as AttendeeColumnLayout };

/** Question data for displaying answers in the attendee table. */
export type TableQuestionData = AttendeeQuestionData;

/** Options passed to attendee column cell renderers. Built once per render
 *  from the public {@link AttendeeTableOptions}. */
export type AttendeeColumnOpts = {
  allowedDomain: string;
  phonePrefix: string;
  /** Render the status cell (check-in button or refunded badge) */
  renderStatus: (row: AttendeeTableRow) => Child;
  /** Answer maps for question-based columns */
  answerTextMap: Map<number, string>;
  answerQuestionMap: Map<number, string>;
  /** Question data for the answers column */
  questionData?: TableQuestionData | undefined;
};

type AttendeeCol = TableColumn<AttendeeTableRow, AttendeeColumnOpts>;

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Format a multi-line address for inline display */
export const formatAddressInline = (addr: string): string => {
  if (!addr) return "";
  return nonBlankLines(addr).reduce((acc, line) => {
    if (!acc) return line;
    return acc.endsWith(",") ? `${acc} ${line}` : `${acc}, ${line}`;
  }, "");
};

/** Format multi-line instructions as single-line text */
const formatInstructionsInline = (instructions: string): string => {
  if (!instructions) return "";
  return instructions.replace(/\r?\n+/g, " ").trim();
};

/** Free-text answers for one attendee: the values plus their "Question: Answer"
 *  tooltip parts. */
const freeTextAnswerParts = (
  attendeeId: number,
  questionData: TableQuestionData,
): { texts: string[]; tooltips: string[] } => {
  const textByQuestion = questionData.textAnswerMap?.get(attendeeId);
  const texts: string[] = [];
  const tooltips: string[] = [];
  for (const q of questionData.questions) {
    if (q.display_type !== "free_text") continue;
    const text = textByQuestion?.get(q.id);
    if (!text) continue;
    texts.push(text);
    tooltips.push(`${q.text}: ${text}`);
  }
  return { texts, tooltips };
};

/** Get attendee answer display */
const getAnswerDisplay = (
  attendeeId: number,
  questionData: TableQuestionData,
  answerTextMap: Map<number, string>,
  answerQuestionMap: Map<number, string>,
): { short: string; tooltip: string } => {
  const answerIds = questionData.attendeeAnswerMap.get(attendeeId) ?? [];
  const answerTexts: string[] = [];
  const tooltipParts: string[] = [];
  for (const aid of answerIds) {
    const text = answerTextMap.get(aid);
    const qText = answerQuestionMap.get(aid);
    if (text) answerTexts.push(text);
    if (text && qText) tooltipParts.push(`${qText}: ${text}`);
  }
  const freeText = freeTextAnswerParts(attendeeId, questionData);
  return {
    short: [...answerTexts, ...freeText.texts].join(", "),
    tooltip: [...tooltipParts, ...freeText.tooltips].join(", "),
  };
};

/** Build both answer lookups in one pass over the questions: answer id → the
 *  answer's text, and answer id → its question's text. */
export const buildAnswerMaps = (
  questions: QuestionWithAnswers[],
): Pick<AttendeeColumnOpts, "answerTextMap" | "answerQuestionMap"> => {
  const answerTextMap = new Map<number, string>();
  const answerQuestionMap = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) {
      answerTextMap.set(a.id, a.text);
      answerQuestionMap.set(a.id, q.text);
    }
  }
  return { answerQuestionMap, answerTextMap };
};

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const name: AttendeeCol = {
  cell: (row) => (
    <a href={attendeeAdminPath(row.attendee)}>{row.attendee.name}</a>
  ),
  description: "Attendee name with link to the edit attendee page",
  header: "Name",
  key: "name",
  label: "Name",
  rawValue: (row) => row.attendee.name,
};

const listings: AttendeeCol = {
  cell: (row) => {
    const links = row.listings.map((l, i) => (
      <>
        {i > 0 && ", "}
        <a href={`/admin/listing/${l.id}`}>{l.name}</a>
      </>
    ));
    const fullList = row.listings.map((l) => l.name).join(", ");
    return (
      <span class="listings-cell" title={fullList}>
        {links}
      </span>
    );
  },
  description:
    "The row's listings in display order, each linked to its detail page",
  header: "Listings",
  key: "listings",
  label: "Listings",
};

const date: AttendeeCol = {
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  description: "Booking date for daily listings",
  header: "Date",
  key: "date",
  label: "Date",
  rawValue: (row) => row.attendee.date || "",
};

const email: AttendeeCol = {
  cell: (row) => row.attendee.email || "",
  description: "Attendee email address",
  header: "Email",
  key: "email",
  label: "Email",
};

const phone: AttendeeCol = {
  cell: (row, opts) => {
    if (!row.attendee.phone) return "";
    const normalized = normalizePhone(
      row.attendee.phone,
      opts.phonePrefix || "44",
    );
    return <a href={`tel:${normalized}`}>{row.attendee.phone}</a>;
  },
  description: "Attendee phone number (clickable link)",
  header: "Phone",
  key: "phone",
  label: "Phone",
};

const address: AttendeeCol = {
  cell: (row) => formatAddressInline(row.attendee.address || ""),
  description: "Attendee postal address (inline format)",
  header: "Address",
  key: "address",
  label: "Address",
};

const special_instructions: AttendeeCol = {
  cell: (row) =>
    formatInstructionsInline(row.attendee.special_instructions || ""),
  description: "Any special instructions from the attendee",
  header: "Special Instructions",
  key: "special_instructions",
  label: "Special Instructions",
};

const answers: AttendeeCol = {
  cell: (row, opts) => {
    if (!opts.questionData) return "";
    const { short, tooltip } = getAnswerDisplay(
      row.attendee.id,
      opts.questionData,
      opts.answerTextMap,
      opts.answerQuestionMap,
    );
    return <span title={tooltip}>{short}</span>;
  },
  className: "answers-cell",
  description: "Custom question answers",
  header: "Answers",
  key: "answers",
  label: "Answers",
};

const qty: AttendeeCol = {
  cell: (row) => String(row.attendee.quantity),
  class: "quantity",
  description: "Number of tickets in this booking",
  header: "Qty",
  key: "qty",
  label: "Qty",
  rawValue: (row) => row.attendee.quantity,
};

/** The "No quantity" indicator — a no-quantity sentinel row has no live
 *  customer ticket and is not checkable. Shared by the ticket column's cell
 *  renderer and the status cell renderer so the indicator markup can't
 *  drift between them. */
const noQuantityIndicator = (): JSX.Element => (
  <span class="muted small">{t("admin.attendee_table.no_quantity")}</span>
);

const ticket: AttendeeCol = {
  cell: (row, opts) => {
    if (isServicing(row.attendee.kind)) {
      return (
        <span class="muted small">{t("admin.attendee_table.servicing")}</span>
      );
    }
    if (!hasTicketQuantity(row.attendee)) {
      return noQuantityIndicator();
    }
    return (
      <a href={`https://${opts.allowedDomain}/t/${row.attendee.ticket_token}`}>
        {row.attendee.ticket_token}
      </a>
    );
  },
  description: "Clickable ticket token link",
  header: "Ticket",
  key: "ticket",
  label: "Ticket",
};

const registered: AttendeeCol = {
  cell: (row) => formatDatetimeShort(row.attendee.created),
  description: "Date and time the attendee registered",
  header: "Registered",
  key: "registered",
  label: "Registered",
  rawValue: (row) => row.attendee.created,
};

const status: AttendeeCol = {
  cell: (row, opts) => opts.renderStatus(row),
  className: "actions-col",
  description: "Check-in/check-out button or refunded badge",
  header: "",
  headerClassName: "actions-col",
  key: "status",
  label: "Status",
};

/** The attendee table definition — every column, with the layout keys the
 *  operator's saved template may reference. */
export const attendeeTable = defineTable<AttendeeTableRow, AttendeeColumnOpts>(
  [
    status,
    date,
    name,
    listings,
    email,
    phone,
    address,
    special_instructions,
    answers,
    qty,
    ticket,
    registered,
  ],
  { configKeys: ATTENDEE_COLUMN_KEYS, defaultColumnKeys: ATTENDEE_COLUMN_KEYS },
);

// ---------------------------------------------------------------------------
// Column visibility
// ---------------------------------------------------------------------------

const hideWhenAllBlank = (
  rows: readonly AttendeeTableRow[],
  field: keyof AttendeeTableRow["attendee"],
  columnKey: string,
): Set<string> =>
  rows.some((r) => !!r.attendee[field]) ? new Set() : new Set([columnKey]);

const computeHiddenKeys = (
  rows: AttendeeTableRow[],
  opts: AttendeeTableOptions,
): Set<string> => {
  const showCheckin = opts.showCheckin !== false;
  const hidden = new Set<string>();
  if (!showCheckin) hidden.add("status");
  if (!opts.showListing) hidden.add("listings");
  if (!opts.showDate) hidden.add("date");
  for (const columnKey of [
    "address",
    "email",
    "phone",
    "special_instructions",
  ] as const) {
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
// Status rendering
// ---------------------------------------------------------------------------

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

const buildColumnOpts = (opts: AttendeeTableOptions): AttendeeColumnOpts => {
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
    if (!hasTicketQuantity(a)) {
      return noQuantityIndicator();
    }
    if (a.refunded) {
      return (
        <span class="muted small">
          {t("admin.attendee_table.refunded_badge")}
        </span>
      );
    }
    return CheckinButton({
      a,
      activeFilter: opts.activeFilter ?? "all",
      listingId: row.listings[0]?.id ?? 0,
      returnUrl: opts.returnUrl,
    });
  };

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

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
  /** Show the check-in/check-out status column (default: true). */
  showCheckin?: boolean | undefined;
  /** Skip default sort and use rows as-is (default: false) */
  presorted?: boolean | undefined;
  /** Question data for the Answers column */
  questionData?: AttendeeQuestionData | undefined;
  /** Pre-parsed layout controlling column order and filters */
  columnLayout?: TableLayout | undefined;
};

/** Render the unified attendee table. */
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
