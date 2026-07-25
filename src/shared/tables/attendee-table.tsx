/**
 * The attendee table: the columns shown on the listing detail page, the
 * check-in view, and the calendar. The cell renderer for each column lives
 * here once; the templates render through `renderTable`.
 *
 * Like the listing table, the attendee table's column order is
 * user-configurable: the operator picks which columns appear (and in what
 * order) via a Liquid template saved in `attendee_column_order`. The
 * column keys this table exposes — every column's key — are what the layout
 * parser accepts.
 *
 * Cells take a per-table {@link AttendeeColumnOpts} context carrying the
 * cross-cell collaborators a row needs: the rendered check-in button for
 * the status column, the question/answer maps for answers, the phone prefix
 * for normalising phone numbers, the allowed domain for the ticket link.
 */

import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { AttendeeQuestionData } from "#shared/db/questions/attendee-answers/reads.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { nonBlankLines } from "#shared/lines.ts";
import { normalizePhone } from "#shared/phone.ts";
import {
  ATTENDEE_COLUMN_KEYS,
  ATTENDEE_DEFAULT_COLUMN_KEYS,
} from "#shared/tables/attendee-layout.ts";
import { type TableColumn, defineTable } from "#shared/tables/definition.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";

/** Question data for displaying answers in the attendee table.
 *  Canonical shape lives in the questions module; aliased here so existing
 *  importers keep their `TableQuestionData` reference. */
export type TableQuestionData = AttendeeQuestionData;

/** Options passed to attendee column cell renderers. Built once per render
 *  from the public {@link AttendeeTableOptions} (which carries the
 *  caller-supplied view state: `allowedDomain`, `phonePrefix`,
 *  `questionData`, `returnUrl`, `activeFilter`, `renderStatus`). */
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
  // The wrapping span carries the full comma-separated list in its title and
  // the .listings-cell truncation styles, so a long list ellipsizes at 30rem
  // while hovering reveals every listing name.
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

/** Free-text answers for one attendee: the values plus their "Question: Answer"
 * tooltip parts. Carry no answer id, so pulled per free_text question from the
 * decrypted text map (present only when the loader fetched it). */
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

const answers: AttendeeCol = {
  cell: (row, opts) => {
    if (!opts.questionData) return "";
    const { short, tooltip } = getAnswerDisplay(
      row.attendee.id,
      opts.questionData,
      opts.answerTextMap,
      opts.answerQuestionMap,
    );
    return (
      <span class="answers-cell" title={tooltip}>
        {short}
      </span>
    );
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

const ticket: AttendeeCol = {
  // A no-quantity sentinel row has no live customer ticket: /t renders the
  // attendee's OTHER real bookings (or 404s for an all-ghost attendee), so a
  // link here would let staff copy a customer-facing URL that doesn't match this
  // row's cancelled/interested listing. Show the indicator instead.
  cell: (row, opts) => {
    if (isServicing(row.attendee.kind)) {
      return (
        <span class="muted small">{t("admin.attendee_table.servicing")}</span>
      );
    }
    if (!hasTicketQuantity(row.attendee)) {
      return (
        <span class="muted small">{t("admin.attendee_table.no_quantity")}</span>
      );
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

/** The status column: headerless + classed, since the cell is a check-in
 *  button or refunded badge that doesn't need a column header. */
const status: AttendeeCol = {
  cell: (row, opts) => opts.renderStatus(row),
  className: "actions-col",
  description: "Check-in/check-out button or refunded badge",
  header: "",
  headerClassName: "actions-col",
  key: "status",
  label: "Status",
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

/** The attendee table — every column, in declaration order. Not configurable
 *  beyond the default set (no extras): every key in this table is part of
 *  the layout's accepted keys. */
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
  {
    defaultColumnKeys: ATTENDEE_DEFAULT_COLUMN_KEYS,
    configKeys: ATTENDEE_COLUMN_KEYS,
  },
);

/** Re-export so existing importers can read ATTENDEE_TABLE_COLUMNS off the
 *  new module during the migration. New callers should import `attendeeTable`
 *  directly. */
export { attendeeTable as ATTENDEE_TABLE_COLUMNS };
