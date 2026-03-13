/**
 * Unified attendee table component — renders attendee lists consistently
 * across the event detail, check-in, and calendar views.
 */

import { map, pipe, reduce, sort } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
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
};

/** Column visibility flags computed from data */
type Visibility = {
  showEvent: boolean;
  showDate: boolean;
  showEmail: boolean;
  showPhone: boolean;
  showAddress: boolean;
  showSpecialInstructions: boolean;
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
});

/** Count visible columns for colspan on empty row */
const countColumns = (vis: Visibility, showActions: boolean): number => {
  let count = 4; // Name, Qty, Ticket, Registered
  if (showActions) count += 2; // Checked In, Actions
  if (vis.showEvent) count++;
  if (vis.showDate) count++;
  if (vis.showEmail) count++;
  if (vis.showPhone) count++;
  if (vis.showAddress) count++;
  if (vis.showSpecialInstructions) count++;
  return count;
};

/** Compare attendee rows for deterministic table ordering */
const compareAttendeeRows = (
  a: AttendeeTableRow,
  b: AttendeeTableRow,
): number => {
  // 1. Event date: rows with dates first, then ascending
  const dateA = a.attendee.date ?? "";
  const dateB = b.attendee.date ?? "";
  if (dateA !== "" || dateB !== "") {
    if (dateA === "") return 1;
    if (dateB === "") return -1;
    const dateCmp = dateA.localeCompare(dateB);
    if (dateCmp !== 0) return dateCmp;
  }

  // 2. Event name
  const nameCmp = a.eventName.localeCompare(b.eventName);
  if (nameCmp !== 0) return nameCmp;

  // 3. Attendee name
  const attendeeCmp = a.attendee.name.localeCompare(b.attendee.name);
  if (attendeeCmp !== 0) return attendeeCmp;

  // 4. Attendee id
  return a.attendee.id - b.attendee.id;
};

/** Sort attendee rows by date, event name, attendee name, then id */
export const sortAttendeeRows: (
  rows: AttendeeTableRow[],
) => AttendeeTableRow[] = sort(compareAttendeeRows);

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

/** Render a single attendee row */
const AttendeeRow = ({
  row,
  vis,
  opts,
}: {
  row: AttendeeTableRow;
  vis: Visibility;
  opts: AttendeeTableOptions;
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
      {vis.showEmail && <td>{a.email || ""}</td>}
      {vis.showPhone && (
        <td>
          {a.phone ? (
            <a
              href={`tel:${normalizePhone(a.phone, opts.phonePrefix || "44")}`}
            >
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

/** Render the unified attendee table */
export const AttendeeTable = (opts: AttendeeTableOptions): string => {
  const orderedRows = opts.presorted ? opts.rows : sortAttendeeRows(opts.rows);
  const vis = computeVisibility(orderedRows, opts);
  const showActions = opts.showActions !== false;
  const colCount = countColumns(vis, showActions);

  const rows =
    orderedRows.length > 0
      ? pipe(
          map((row: AttendeeTableRow) => AttendeeRow({ row, vis, opts })),
          joinStrings,
        )(orderedRows)
      : `<tr><td colspan="${colCount}">${opts.emptyMessage ?? "No attendees yet"}</td></tr>`;

  return String(
    <table>
      <thead>
        <tr>
          {showActions && <th></th>}
          {vis.showEvent && <th>Event</th>}
          {vis.showDate && <th>Date</th>}
          <th>Name</th>
          {vis.showEmail && <th>Email</th>}
          {vis.showPhone && <th>Phone</th>}
          {vis.showAddress && <th>Address</th>}
          {vis.showSpecialInstructions && <th>Special Instructions</th>}
          <th>Qty</th>
          <th>Ticket</th>
          <th>Registered</th>
          {showActions && <th></th>}
        </tr>
      </thead>
      <tbody>
        <Raw html={rows} />
      </tbody>
    </table>,
  );
};
