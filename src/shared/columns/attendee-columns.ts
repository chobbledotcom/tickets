/**
 * Attendee table column definitions — single source of truth.
 *
 * Every column's rendering logic lives here. The table component
 * iterates the ordered columns and calls each one's cell() function.
 */

import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import type { AttendeeColumn, ColumnDef } from "#shared/column-order.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import { nonBlankLines } from "#shared/lines.ts";
import { normalizePhone } from "#shared/phone.ts";
import { type AttendeeTableRow, hasTicketQuantity } from "#shared/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { escapeHtml } from "#templates/layout.tsx";

type AttendeeCol = ColumnDef<AttendeeTableRow, AttendeeColumnOpts>;

/** Shared base for columns rendered via callbacks (status, actions) */
const componentRenderedCol = (
  label: string,
  description: string,
  cellFn: (row: AttendeeTableRow, opts: AttendeeColumnOpts) => string,
): AttendeeCol => ({
  cell: cellFn,
  className: "actions-col",
  description,
  headerClassName: "actions-col",
  headerText: "",
  isHtml: true,
  label,
});

const status = componentRenderedCol(
  "Status",
  "Check-in/check-out button or refunded badge",
  (row, opts) => opts.renderStatus(row),
);

const listings: AttendeeCol = {
  // The wrapping span carries the full comma-separated list in its title and
  // the .listings-cell truncation styles, so a long list ellipsizes at 30rem
  // while hovering reveals every listing name.
  cell: (row) => {
    const fullList = escapeHtml(row.listings.map((l) => l.name).join(", "));
    const links = row.listings
      .map((l) => `<a href="/admin/listing/${l.id}">${escapeHtml(l.name)}</a>`)
      .join(", ");
    return `<span class="listings-cell" title="${fullList}">${links}</span>`;
  },
  description:
    "The row's listings in display order, each linked to its detail page",
  isHtml: true,
  label: "Listings",
};

const date: AttendeeCol = {
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  description: "Booking date for daily listings",
  label: "Date",
  rawValue: (row) => row.attendee.date || "",
};

const name: AttendeeCol = {
  cell: (row) =>
    `<a href="${attendeeAdminPath(row.attendee)}">${escapeHtml(row.attendee.name)}</a>`,
  description: "Attendee name with link to the edit attendee page",
  isHtml: true,
  label: "Name",
};

const email: AttendeeCol = {
  cell: (row) => row.attendee.email || "",
  description: "Attendee email address",
  label: "Email",
};

const phone: AttendeeCol = {
  cell: (row, opts) => {
    if (!row.attendee.phone) return "";
    const normalized = normalizePhone(
      row.attendee.phone,
      opts.phonePrefix || "44",
    );
    return `<a href="tel:${normalized}">${escapeHtml(row.attendee.phone)}</a>`;
  },
  description: "Attendee phone number (clickable link)",
  isHtml: true,
  label: "Phone",
};

const address: AttendeeCol = {
  cell: (row) => formatAddressInline(row.attendee.address),
  description: "Attendee postal address (inline format)",
  label: "Address",
};

const special_instructions: AttendeeCol = {
  cell: (row) => formatInstructionsInline(row.attendee.special_instructions),
  description: "Any special instructions from the attendee",
  label: "Special Instructions",
};

/** Free-text answers for one attendee: the values plus their "Question: Answer"
 * tooltip parts. Carry no answer id, so pulled per free_text question from the
 * decrypted text map (present only when the loader fetched it). */
const freeTextAnswerParts = (
  attendeeId: number,
  questionData: import("#templates/attendee-table.tsx").TableQuestionData,
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
  questionData: import("#templates/attendee-table.tsx").TableQuestionData,
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
    const { short, tooltip } = getAnswerDisplay(
      row.attendee.id,
      opts.questionData!,
      opts.answerTextMap,
      opts.answerQuestionMap,
    );
    return `<span title="${escapeHtml(tooltip)}">${escapeHtml(short)}</span>`;
  },
  className: "answers-cell",
  description: "Custom question answers",
  isHtml: true,
  label: "Answers",
};

const qty: AttendeeCol = {
  cell: (row) => String(row.attendee.quantity),
  className: colClass("quantity"),
  description: "Number of tickets in this booking",
  headerClassName: colClass("quantity"),
  label: "Qty",
};

const ticket: AttendeeCol = {
  // A no-quantity sentinel row has no live customer ticket: /t renders the
  // attendee's OTHER real bookings (or 404s for an all-ghost attendee), so a
  // link here would let staff copy a customer-facing URL that doesn't match this
  // row's cancelled/interested listing. Show the indicator instead.
  cell: (row, opts) =>
    isServicing(row.attendee.kind)
      ? `<span class="muted small">${t("admin.attendee_table.servicing")}</span>`
      : !hasTicketQuantity(row.attendee)
        ? `<span class="muted small">${t("admin.attendee_table.no_quantity")}</span>`
        : `<a href="https://${opts.allowedDomain}/t/${row.attendee.ticket_token}">${row.attendee.ticket_token}</a>`,
  description: "Clickable ticket token link",
  isHtml: true,
  label: "Ticket",
};

const registered: AttendeeCol = {
  cell: (row) => formatDatetimeShort(row.attendee.created),
  description: "Date and time the attendee registered",
  label: "Registered",
  rawValue: (row) => row.attendee.created,
};

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available attendee table columns */
export const ATTENDEE_TABLE_COLUMNS = {
  address,
  answers,
  date,
  email,
  listings,
  name,
  phone,
  qty,
  registered,
  special_instructions,
  status,
  ticket,
} satisfies Record<AttendeeColumn, AttendeeCol>;
