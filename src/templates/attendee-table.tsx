/**
 * Unified attendee table component — renders attendee lists consistently
 * across the event detail, check-in, and calendar views.
 */

import { flatMap, map, pipe, reduce, sort } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
import type { Answer, QuestionWithAnswers } from "#lib/db/questions.ts";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { normalizePhone } from "#lib/phone.ts";
import type { Attendee } from "#lib/types.ts";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** A single row in the unified attendee table */
export type AttendeeTableRow = {
  attendee: Attendee;
  eventId: number;
  eventName: string;
};

/** Question data for displaying answers in the attendee table */
export type TableQuestionData = {
  questions: QuestionWithAnswers[];
  attendeeAnswerMap: Map<number, number[]>;
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
};

/** Column visibility flags computed from data */
type Visibility = {
  showEvent: boolean;
  showDate: boolean;
  showEmail: boolean;
  showPhone: boolean;
  showAddress: boolean;
  showSpecialInstructions: boolean;
  showAnswers: boolean;
};

/** Format a multi-line address for inline display */
export const formatAddressInline = (address: string): string => {
  if (!address) return "";
  return address
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

/** Compute which optional columns have data */
const computeVisibility = (
  rows: AttendeeTableRow[],
  opts: AttendeeTableOptions,
): Visibility => ({
  showEvent: opts.showEvent,
  showDate: opts.showDate,
  showEmail: rows.some((r) => !!r.attendee.email),
  showPhone: rows.some((r) => !!r.attendee.phone),
  showAddress: rows.some((r) => !!r.attendee.address),
  showSpecialInstructions: rows.some((r) => !!r.attendee.special_instructions),
  showAnswers: !!opts.questionData && opts.questionData.questions.length > 0,
});

/** Count visible columns for colspan on empty row */
const countColumns = (vis: Visibility, showActions: boolean): number =>
  4 + // Name, Qty, Ticket, Registered
  (showActions ? 2 : 0) + // Checked In, Actions
  +vis.showEvent +
  +vis.showDate +
  +vis.showEmail +
  +vis.showPhone +
  +vis.showAddress +
  +vis.showSpecialInstructions +
  +vis.showAnswers;

/** Compare dates: rows with dates come first, then ascending */
const compareDates = (dateA: string, dateB: string): number => {
  if (dateA === "" && dateB === "") return 0;
  if (dateA === "") return 1;
  if (dateB === "") return -1;
  return dateA.localeCompare(dateB);
};

/** Compare attendee rows for deterministic table ordering */
const compareAttendeeRows = (
  a: AttendeeTableRow,
  b: AttendeeTableRow,
): number =>
  compareDates(a.attendee.date ?? "", b.attendee.date ?? "") ||
  a.eventName.localeCompare(b.eventName) ||
  a.attendee.name.localeCompare(b.attendee.name) ||
  a.attendee.id - b.attendee.id;

/** Sort attendee rows by date, event name, attendee name, then id */
export const sortAttendeeRows: (
  rows: AttendeeTableRow[],
) => AttendeeTableRow[] = sort(compareAttendeeRows);

/** Build answer text map from questions */
const buildAnswerTextMap = (
  questions: QuestionWithAnswers[],
): Map<number, string> =>
  pipe(
    flatMap((q: QuestionWithAnswers) => q.answers),
    reduce((m: Map<number, string>, a: Answer) => {
      m.set(a.id, a.text);
      return m;
    }, new Map<number, string>()),
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

/** Get attendee answer display: short text (comma-separated answers) and tooltip (key: value) */
const getAttendeeAnswerDisplay = (
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
  return {
    short: answerTexts.join(", "),
    tooltip: tooltipParts.join(", "),
  };
};

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

/** Render the actions cell for a row */
const ActionsCell = ({
  row,
  returnUrl,
}: {
  row: AttendeeTableRow;
  returnUrl: string | undefined;
}): string => {
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

/** Render the first column: refunded badge or check-in/out button */
const StatusCell = ({
  row,
  opts,
}: {
  row: AttendeeTableRow;
  opts: AttendeeTableOptions;
}): string => {
  if (row.attendee.refunded) {
    return String(<span class="badge-refunded">Refunded</span>);
  }
  return CheckinButton({
    a: row.attendee,
    eventId: row.eventId,
    activeFilter: opts.activeFilter ?? "all",
    returnUrl: opts.returnUrl,
  });
};

/** Render the optional contact/detail columns for a row */
const ContactColumns = ({
  a,
  vis,
  phonePrefix,
}: {
  a: Attendee;
  vis: Visibility;
  phonePrefix: string;
}): string =>
  String(
    <>
      {vis.showEmail && <td>{a.email || ""}</td>}
      {vis.showPhone && (
        <td>
          {a.phone ? (
            <a href={`tel:${normalizePhone(a.phone, phonePrefix)}`}>
              {a.phone}
            </a>
          ) : (
            ""
          )}
        </td>
      )}
      {vis.showAddress && <td>{formatAddressInline(a.address)}</td>}
      {vis.showSpecialInstructions && (
        <td>{formatInstructionsInline(a.special_instructions)}</td>
      )}
    </>,
  );

/** Render a single attendee row */
const AttendeeRow = ({
  row,
  vis,
  opts,
  answerTextMap,
  answerQuestionMap,
}: {
  row: AttendeeTableRow;
  vis: Visibility;
  opts: AttendeeTableOptions;
  answerTextMap: Map<number, string>;
  answerQuestionMap: Map<number, string>;
}): string => {
  const a = row.attendee;
  const showActions = opts.showActions !== false;
  return String(
    <tr>
      {showActions && (
        <td>
          <Raw html={StatusCell({ row, opts })} />
        </td>
      )}
      {vis.showEvent && (
        <td>
          <a href={`/admin/event/${row.eventId}`}>{row.eventName}</a>
        </td>
      )}
      {vis.showDate && <td>{a.date ? formatDateLabel(a.date) : ""}</td>}
      <td>{a.name}</td>
      <Raw
        html={ContactColumns({
          a,
          vis,
          phonePrefix: opts.phonePrefix || "44",
        })}
      />
      {vis.showAnswers && opts.questionData && (
        <Raw
          html={renderAnswerCell(
            a.id,
            opts.questionData,
            answerTextMap,
            answerQuestionMap,
          )}
        />
      )}
      <td>{a.quantity}</td>
      <td>
        <a href={`https://${opts.allowedDomain}/t/${a.ticket_token}`}>
          {a.ticket_token}
        </a>
      </td>
      <td>{new Date(a.created).toLocaleString()}</td>
      {showActions && (
        <td>
          <Raw html={ActionsCell({ row, returnUrl: opts.returnUrl })} />
        </td>
      )}
    </tr>,
  );
};

/** Render an answer cell for an attendee */
const renderAnswerCell = (
  attendeeId: number,
  questionData: TableQuestionData,
  answerTextMap: Map<number, string>,
  answerQuestionMap: Map<number, string>,
): string => {
  const { short, tooltip } = getAttendeeAnswerDisplay(
    attendeeId,
    questionData,
    answerTextMap,
    answerQuestionMap,
  );
  return String(
    <td class="answers-cell" title={tooltip}>
      {short}
    </td>,
  );
};

/** Render optional contact/detail column headers */
const ContactHeaderColumns = ({ vis }: { vis: Visibility }): string =>
  String(
    <>
      {vis.showEmail && <th>Email</th>}
      {vis.showPhone && <th>Phone</th>}
      {vis.showAddress && <th>Address</th>}
      {vis.showSpecialInstructions && <th>Special Instructions</th>}
      {vis.showAnswers && <th>Answers</th>}
    </>,
  );

/** Render the table header row */
const TableHeader = ({
  vis,
  showActions,
}: {
  vis: Visibility;
  showActions: boolean;
}): string =>
  String(
    <tr>
      {showActions && <th></th>}
      {vis.showEvent && <th>Event</th>}
      {vis.showDate && <th>Date</th>}
      <th>Name</th>
      <Raw html={ContactHeaderColumns({ vis })} />
      <th>Qty</th>
      <th>Ticket</th>
      <th>Registered</th>
      {showActions && <th></th>}
    </tr>,
  );

/** Render the unified attendee table */
export const AttendeeTable = (opts: AttendeeTableOptions): string => {
  const orderedRows = opts.presorted ? opts.rows : sortAttendeeRows(opts.rows);
  const vis = computeVisibility(orderedRows, opts);
  const showActions = opts.showActions !== false;
  const colCount = countColumns(vis, showActions);

  const answerTextMap = vis.showAnswers
    ? buildAnswerTextMap(opts.questionData!.questions)
    : new Map<number, string>();
  const answerQuestionMap = vis.showAnswers
    ? buildAnswerQuestionMap(opts.questionData!.questions)
    : new Map<number, string>();

  const rows =
    orderedRows.length > 0
      ? pipe(
          map((row: AttendeeTableRow) =>
            AttendeeRow({ row, vis, opts, answerTextMap, answerQuestionMap }),
          ),
          joinStrings,
        )(orderedRows)
      : `<tr><td colspan="${colCount}">${opts.emptyMessage ?? "No attendees yet"}</td></tr>`;

  return String(
    <table>
      <thead>
        <Raw html={TableHeader({ vis, showActions })} />
      </thead>
      <tbody>
        <Raw html={rows} />
      </tbody>
    </table>,
  );
};
