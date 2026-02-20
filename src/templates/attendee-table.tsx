/**
 * Unified attendee table component — renders attendee lists consistently
 * across the event detail, check-in, and calendar views.
 */

import { map, pipe, reduce, sort } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { Attendee } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** A single row in the unified attendee table */
export type AttendeeTableRow = {
  attendee: Attendee;
  eventId: number;
  eventName: string;
  hasPaidEvent: boolean;
};

/** Options for the unified AttendeeTable component */
export type AttendeeTableOptions = {
  rows: AttendeeTableRow[];
  allowedDomain: string;
  csrfToken: string;
  showEvent: boolean;
  showDate: boolean;
  activeFilter?: string;
  returnUrl?: string;
  emptyMessage?: string;
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
const computeVisibility = (rows: AttendeeTableRow[], opts: AttendeeTableOptions): Visibility => ({
  showEvent: opts.showEvent,
  showDate: opts.showDate,
  showEmail: rows.some((r) => !!r.attendee.email),
  showPhone: rows.some((r) => !!r.attendee.phone),
  showAddress: rows.some((r) => !!r.attendee.address),
  showSpecialInstructions: rows.some((r) => !!r.attendee.special_instructions),
});

/** Count visible columns for colspan on empty row */
const countColumns = (vis: Visibility): number => {
  let count = 6; // Checked In, Name, Qty, Ticket, Registered, Actions
  if (vis.showEvent) count++;
  if (vis.showDate) count++;
  if (vis.showEmail) count++;
  if (vis.showPhone) count++;
  if (vis.showAddress) count++;
  if (vis.showSpecialInstructions) count++;
  return count;
};

/** Compare attendee rows for deterministic table ordering */
const compareAttendeeRows = (a: AttendeeTableRow, b: AttendeeTableRow): number => {
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
export const sortAttendeeRows: (rows: AttendeeTableRow[]) => AttendeeTableRow[] =
  sort(compareAttendeeRows);

/** Build a return_url query suffix for action links */
const returnSuffix = (returnUrl: string | undefined): string =>
  returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : "";

/** Render the check-in/check-out button form */
const CheckinButton = ({ a, eventId, csrfToken, activeFilter, returnUrl }: {
  a: Attendee;
  eventId: number;
  csrfToken: string;
  activeFilter: string;
  returnUrl: string | undefined;
}): string => {
  const isCheckedIn = a.checked_in === "true";
  const label = isCheckedIn ? "Check out" : "Check in";
  const buttonClass = isCheckedIn ? "link-button checkout" : "link-button checkin";
  return String(
    <CsrfForm
      action={`/admin/event/${eventId}/attendee/${a.id}/checkin`}
      csrfToken={csrfToken}
      class="inline"
    >
      <input type="hidden" name="return_filter" value={activeFilter} />
      {returnUrl && <input type="hidden" name="return_url" value={returnUrl} />}
      <button type="submit" class={buttonClass}>
        {label}
      </button>
    </CsrfForm>
  );
};

/** Check if attendee is eligible for refund (has payment, not yet refunded) */
const isRefundable = (row: AttendeeTableRow): boolean =>
  row.hasPaidEvent && !!row.attendee.payment_id && row.attendee.refunded !== "true";

/** Render the actions cell for a row */
const ActionsCell = ({ row, returnUrl }: { row: AttendeeTableRow; returnUrl: string | undefined }): string => {
  const a = row.attendee;
  const suffix = returnSuffix(returnUrl);
  return String(
    <>
      {isRefundable(row) && (
        <a href={`/admin/event/${row.eventId}/attendee/${a.id}/refund${suffix}`} class="danger">
          Refund
        </a>
      )}
      {isRefundable(row) && " "}
      <a href={`/admin/attendees/${a.id}${suffix}`}>
        Edit
      </a>
      {" "}
      <a href={`/admin/event/${row.eventId}/attendee/${a.id}/delete${suffix}`} class="danger">
        Delete
      </a>
      {" "}
      <a href={`/admin/event/${row.eventId}/attendee/${a.id}/resend-webhook${suffix}`}>
        Re-send Webhook
      </a>
    </>
  );
};

/** Render the first column: refunded badge or check-in/out button */
const StatusCell = ({ row, opts }: {
  row: AttendeeTableRow;
  opts: AttendeeTableOptions;
}): string => {
  if (row.attendee.refunded === "true") {
    return String(<span style="color:red;font-weight:bold">Refunded</span>);
  }
  return CheckinButton({
    a: row.attendee,
    eventId: row.eventId,
    csrfToken: opts.csrfToken,
    activeFilter: opts.activeFilter ?? "all",
    returnUrl: opts.returnUrl,
  });
};

/** Render a single attendee row */
const AttendeeRow = ({ row, vis, opts }: {
  row: AttendeeTableRow;
  vis: Visibility;
  opts: AttendeeTableOptions;
}): string => {
  const a = row.attendee;
  return String(
    <tr>
      <td>
        <Raw html={StatusCell({ row, opts })} />
      </td>
      {vis.showEvent && <td><a href={`/admin/event/${row.eventId}`}>{row.eventName}</a></td>}
      {vis.showDate && <td>{a.date ? formatDateLabel(a.date) : ""}</td>}
      <td>{a.name}</td>
      {vis.showEmail && <td>{a.email || ""}</td>}
      {vis.showPhone && <td>{a.phone || ""}</td>}
      {vis.showAddress && <td>{formatAddressInline(a.address)}</td>}
      {vis.showSpecialInstructions && <td>{formatInstructionsInline(a.special_instructions)}</td>}
      <td>{a.quantity}</td>
      <td><a href={`https://${opts.allowedDomain}/t/${a.ticket_token}`}>{a.ticket_token}</a></td>
      <td>{new Date(a.created).toLocaleString()}</td>
      <td>
        <Raw html={ActionsCell({ row, returnUrl: opts.returnUrl })} />
      </td>
    </tr>
  );
};

/** Render the unified attendee table */
export const AttendeeTable = (opts: AttendeeTableOptions): string => {
  const sortedRows = sortAttendeeRows(opts.rows);
  const vis = computeVisibility(sortedRows, opts);
  const colCount = countColumns(vis);

  const rows = sortedRows.length > 0
    ? pipe(
        map((row: AttendeeTableRow) => AttendeeRow({ row, vis, opts })),
        joinStrings,
      )(sortedRows)
    : `<tr><td colspan="${colCount}">${opts.emptyMessage ?? "No attendees yet"}</td></tr>`;

  return String(
    <table>
      <thead>
        <tr>
          <th></th>
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
          <th></th>
        </tr>
      </thead>
      <tbody>
        <Raw html={rows} />
      </tbody>
    </table>
  );
};
