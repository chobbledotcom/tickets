/**
 * Attendee table column definitions — single source of truth.
 *
 * Every column's rendering logic lives here. The table component
 * iterates the ordered columns and calls each one's cell() function.
 */

import type { ColumnDef, ColumnGenerators } from "#shared/column-order.ts";
import { formatDateLabel, formatDatetimeShort } from "#shared/dates.ts";
import { normalizePhone } from "#shared/phone.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
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

const listing: AttendeeCol = {
  cell: (row) =>
    `<a href="/admin/listing/${row.listingId}">${escapeHtml(row.listingName)}</a>`,
  description: "Listing name with link to the listing detail page",
  isHtml: true,
  label: "Listing",
};

const date: AttendeeCol = {
  cell: (row) => (row.attendee.date ? formatDateLabel(row.attendee.date) : ""),
  description: "Booking date for daily listings",
  label: "Date",
  rawValue: (row) => row.attendee.date || "",
};

const name: AttendeeCol = {
  cell: (row) =>
    `<a href="/admin/attendees/${row.attendee.id}">${escapeHtml(row.attendee.name)}</a>`,
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
  // Free-text answers carry no answer id, so pull them per free_text question
  // from the decrypted text map (present only when the loader fetched it).
  const textByQuestion = questionData.textAnswerMap?.get(attendeeId);
  if (textByQuestion) {
    for (const q of questionData.questions) {
      if (q.display_type !== "free_text") continue;
      const text = textByQuestion.get(q.id);
      if (!text) continue;
      answerTexts.push(text);
      tooltipParts.push(`${q.text}: ${text}`);
    }
  }
  return {
    short: answerTexts.join(", "),
    tooltip: tooltipParts.join(", "),
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
  description: "Number of tickets in this booking",
  label: "Qty",
};

const ticket: AttendeeCol = {
  cell: (row, opts) =>
    `<a href="https://${opts.allowedDomain}/t/${row.attendee.ticket_token}">${row.attendee.ticket_token}</a>`,
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
  address,
  answers,
  date,
  email,
  listing,
  name,
  phone,
  qty,
  registered,
  special_instructions,
  status,
  ticket,
};

/** Default column order for the attendee table */
export const ATTENDEE_DEFAULT_ORDER = [
  "status",
  "listing",
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
] as const;
