/**
 * Admin templates for managing attendee statuses (owner-only settings page).
 */

import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

const LIST_PATH = "/admin/settings/statuses";

/** Small inline badge for a status flag. */
const Badge = ({ label }: { label: string }): JSX.Element => (
  <span class="badge"> {label} </span>
);

/** Render one row's flag badges. */
const statusBadges = (s: AttendeeStatus): JSX.Element => (
  <>
    {s.is_public_default && <Badge label="Public default" />}
    {s.is_paid_default && <Badge label="Paid" />}
    {s.is_reservation && (
      <Badge label={`Reservation: ${s.reservation_amount}`} />
    )}
  </>
);

/** Move-up / move-down controls for reordering a status. */
const moveControls = (s: AttendeeStatus, i: number, count: number) => (
  <>
    {i > 0 && (
      <CsrfForm action={`${LIST_PATH}/${s.id}/move-up`} class="inline">
        <button class="link-button small" title="Move up" type="submit">
          &#9650;
        </button>
      </CsrfForm>
    )}{" "}
    {i < count - 1 && (
      <CsrfForm action={`${LIST_PATH}/${s.id}/move-down`} class="inline">
        <button class="link-button small" title="Move down" type="submit">
          &#9660;
        </button>
      </CsrfForm>
    )}
  </>
);

/** List of attendee statuses with reorder, edit and delete controls. */
export const adminAttendeeStatusesPage = (
  statuses: AttendeeStatus[],
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Attendee Statuses">
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />
      <h1>Attendee Statuses</h1>
      <p>
        Statuses track where an attendee is in your workflow. The{" "}
        <strong>public default</strong> is the status new public bookings start
        in; if it is a <strong>reservation</strong>, bookings pay a deposit now
        and the balance later. When a balance is paid the attendee moves to the{" "}
        <strong>paid</strong> status.
      </p>
      <Flash error={error} success={success} />
      <p class="actions">
        <ActionButton href={`${LIST_PATH}/new`} icon="plus">
          Add status
        </ActionButton>
      </p>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Name</th>
            <th>Flags</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((s, i) => (
            <tr>
              <td>{moveControls(s, i, statuses.length)}</td>
              <td>
                <a href={`${LIST_PATH}/${s.id}/edit`}>{s.name}</a>
              </td>
              <td>{statusBadges(s)}</td>
              <td>
                <a href={`${LIST_PATH}/${s.id}/edit`}>Edit</a>{" "}
                <CsrfForm action={`${LIST_PATH}/${s.id}/delete`} class="inline">
                  <button class="link-button danger small" type="submit">
                    Delete
                  </button>
                </CsrfForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );

const checkbox = (
  name: string,
  label: string,
  checked: boolean,
): JSX.Element => (
  <label class="checkbox">
    <input checked={checked} name={name} type="checkbox" value="1" /> {label}
  </label>
);

/** Shared new/edit form for an attendee status. */
export const adminAttendeeStatusFormPage = (
  session: AdminSession,
  opts: { status?: AttendeeStatus; error?: string } = {},
): string => {
  const { status, error } = opts;
  const editing = status !== undefined;
  const action = editing ? `${LIST_PATH}/${status.id}/edit` : LIST_PATH;
  return String(
    <Layout title={editing ? "Edit Attendee Status" : "Add Attendee Status"}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />
      <h1>{editing ? "Edit Attendee Status" : "Add Attendee Status"}</h1>
      <Flash error={error} />
      <CsrfForm action={action}>
        <label>
          Name
          <input name="name" required type="text" value={status?.name ?? ""} />
        </label>
        <fieldset class="checkboxes">
          {checkbox(
            "is_reservation",
            "This is a reservation — collect a deposit now, balance later",
            status?.is_reservation ?? false,
          )}
          {checkbox(
            "is_public_default",
            "Default status for new public bookings",
            status?.is_public_default ?? false,
          )}
          {checkbox(
            "is_paid_default",
            "Status an attendee moves to when their balance is paid",
            status?.is_paid_default ?? false,
          )}
        </fieldset>
        <label>
          Reservation amount
          <input
            name="reservation_amount"
            type="text"
            value={status?.reservation_amount ?? "0"}
          />
          <small>{RESERVATION_AMOUNT_HINT}. Only used for reservations.</small>
        </label>
        <SubmitButton icon={editing ? "save" : "plus"}>
          {editing ? "Save status" : "Create status"}
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};
