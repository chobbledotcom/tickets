/**
 * Attendee table column definitions — single source of truth.
 *
 * Every column's rendering logic lives here. The table component
 * iterates the ordered columns and calls each one's cell() function.
 */

import type { ColumnDef, ColumnGenerators } from "#lib/column-order.ts";
import { formatDateLabel, formatDatetimeShort } from "#lib/dates.ts";
import { normalizePhone } from "#lib/phone.ts";
import type { AttendeeTableRow } from "#lib/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import { escapeHtml } from "#templates/layout.tsx";

type AttendeeCol = ColumnDef<AttendeeTableRow, AttendeeColumnOpts>;

/** Shared base for columns rendered via callbacks (status, actions) */
const componentRenderedCol = (
  label: string,
  description: string,
  cellFn: (row: AttendeeTableRow, opts: AttendeeColumnOpts) => string,
): AttendeeCol => ({
  label,
  headerText: "",
  description,
  cell: cellFn,
  headerClassName: "actions-col",
  className: "actions-col",
  isHtml: true,
});

const status = componentRenderedCol(
  "Status",
  "Check-in/check-out button or refunded badge",
  (row, opts) => opts.renderStatus(row),
);

const event: AttendeeCol = {
  label: "Event",
  description: "Event name with link to the event detail page",
  cell: (row) =>
    `<a href="/admin/event/${row.eventId}">${escapeHtml(row.eventName)}</a>`,
  isHtml: true,
};

const date: AttendeeCol = {
  label: "Date",
  description: "Booking date for daily events",
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  rawValue: (row) => row.attendee.date || "",
};

const name: AttendeeCol = {
  label: "Name",
  description: "Attendee name",
  cell: (row) => row.attendee.name,
};

const email: AttendeeCol = {
  label: "Email",
  description: "Attendee email address",
  cell: (row) => row.attendee.email || "",
};

const phone: AttendeeCol = {
  label: "Phone",
  description: "Attendee phone number (clickable link)",
  cell: (row, opts) => {
    if (!row.attendee.phone) return "";
    const normalized = normalizePhone(
      row.attendee.phone,
      opts.phonePrefix || "44",
    );
    return `<a href="tel:${normalized}">${escapeHtml(row.attendee.phone)}</a>`;
  },
  isHtml: true,
};

const address: AttendeeCol = {
  label: "Address",
  description: "Attendee postal address (inline format)",
  cell: (row) => formatAddressInline(row.attendee.address),
};

const special_instructions: AttendeeCol = {
  label: "Special Instructions",
  description: "Any special instructions from the attendee",
  cell: (row) => formatInstructionsInline(row.attendee.special_instructions),
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
  return {
    short: answerTexts.join(", "),
    tooltip: tooltipParts.join(", "),
  };
};

const answers: AttendeeCol = {
  label: "Answers",
  description: "Custom question answers",
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
  isHtml: true,
};

const qty: AttendeeCol = {
  label: "Qty",
  description: "Number of tickets in this booking",
  cell: (row) => String(row.attendee.quantity),
};

const ticket: AttendeeCol = {
  label: "Ticket",
  description: "Clickable ticket token link",
  cell: (row, opts) =>
    `<a href="https://${opts.allowedDomain}/t/${row.attendee.ticket_token}">${row.attendee.ticket_token}</a>`,
  isHtml: true,
};

const registered: AttendeeCol = {
  label: "Registered",
  description: "Date and time the attendee registered",
  cell: (row) => formatDatetimeShort(row.attendee.created),
  rawValue: (row) => row.attendee.created,
};

const actions = componentRenderedCol(
  "Actions",
  "Refund, edit, delete, and re-send notification links",
  (row, opts) => opts.renderActions(row),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a multi-line address for inline display */
export const formatAddressInline = (addr: string): string => {
  if (!addr) return "";
  return addr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line)
    .reduce((acc, line) => {
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
export const ATTENDEE_TABLE_COLUMNS: ColumnGenerators<
  AttendeeTableRow,
  AttendeeColumnOpts
> = {
  status,
  event,
  date,
  name,
  email,
  phone,
  address,
  special_instructions,
  answers,
  qty,
  ticket,
  registered,
  actions,
};

/** Default column order for the attendee table */
export const ATTENDEE_DEFAULT_ORDER = [
  "status",
  "event",
  "date",
  "name",
  "email",
  "phone",
  "address",
  "special_instructions",
  "answers",
  "qty",
  "ticket",
  "registered",
  "actions",
] as const;
