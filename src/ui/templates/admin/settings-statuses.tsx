/**
 * Admin templates for managing attendee statuses (owner-only settings page).
 */

import { t } from "#i18n";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  DeleteSection,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

const LIST_PATH = "/admin/settings/statuses";

/** Small inline badge for a status flag. */
const Badge = ({ label }: { label: string }): JSX.Element => (
  <span class="badge"> {label} </span>
);

/** Render one row's flag badges. */
const statusBadges = (s: AttendeeStatus): JSX.Element => (
  <>
    {s.is_public_default && (
      <Badge label={t("statuses.badge_public_default")} />
    )}
    {s.is_paid_default && <Badge label={t("statuses.badge_paid")} />}
    {s.is_reservation && (
      <Badge
        label={t("statuses.badge_reservation", {
          amount: s.reservation_amount,
        })}
      />
    )}
  </>
);

/** Move-up / move-down controls for reordering a status. */
const moveControls = (s: AttendeeStatus, i: number, count: number) => (
  <>
    {i > 0 && (
      <CsrfForm action={`${LIST_PATH}/${s.id}/move-up`} class="inline">
        <button
          class="link-button small"
          title={t("statuses.move_up_title")}
          type="submit"
        >
          &#9650;
        </button>
      </CsrfForm>
    )}{" "}
    {i < count - 1 && (
      <CsrfForm action={`${LIST_PATH}/${s.id}/move-down`} class="inline">
        <button
          class="link-button small"
          title={t("statuses.move_down_title")}
          type="submit"
        >
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
    <Layout title={t("statuses.attendee_statuses_page_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <div class="prose">
        <h1>{t("statuses.attendee_statuses_page_title")}</h1>
        <p>
          <Raw html={t("statuses.attendee_statuses_description")} />
        </p>
      </div>
      <Flash error={error} success={success} />
      <p class="actions">
        <ActionButton href={`${LIST_PATH}/new`} icon="plus">
          {t("statuses.add_status_button")}
        </ActionButton>
      </p>
      <table>
        <thead>
          <tr>
            <th>{t("statuses.order_header")}</th>
            <th>{t("common.name")}</th>
            <th>{t("statuses.flags_header")}</th>
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
    <Layout
      title={
        editing ? t("statuses.form_title_edit") : t("statuses.form_title_add")
      }
    >
      <AdminNav active="/admin/settings" session={session} />
      <h1>
        {editing ? t("statuses.form_title_edit") : t("statuses.form_title_add")}
      </h1>
      <Flash error={error} />
      <CsrfForm action={action}>
        <label>
          {t("common.name")}
          <input name="name" required type="text" value={status?.name ?? ""} />
        </label>
        <fieldset class="checkboxes">
          {checkbox(
            "is_reservation",
            t("statuses.form_reservation_checkbox"),
            status?.is_reservation ?? false,
          )}
          {checkbox(
            "is_public_default",
            t("statuses.form_public_default_checkbox"),
            status?.is_public_default ?? false,
          )}
          {checkbox(
            "is_paid_default",
            t("statuses.form_paid_default_checkbox"),
            status?.is_paid_default ?? false,
          )}
        </fieldset>
        <label>
          {t("statuses.form_reservation_amount_label")}
          <input
            name="reservation_amount"
            type="text"
            value={status?.reservation_amount ?? "0"}
          />
          <small>
            {RESERVATION_AMOUNT_HINT}
            {t("statuses.form_reservation_amount_hint")}
          </small>
        </label>
        <SubmitButton icon={editing ? "save" : "plus"}>
          {editing
            ? t("statuses.form_save_button")
            : t("statuses.form_create_button")}
        </SubmitButton>
      </CsrfForm>
      {editing && (
        <DeleteSection
          heading={t("common.delete")}
          href={`${LIST_PATH}/${status.id}/delete`}
        >
          {t("statuses.delete_button")}
        </DeleteSection>
      )}
    </Layout>,
  );
};

/** Confirmation page for deleting an attendee status. */
export const adminAttendeeStatusDeletePage = (
  status: AttendeeStatus,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("statuses.delete_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <ConfirmForm
        action={`${LIST_PATH}/${status.id}/delete`}
        buttonText={t("statuses.delete_button")}
        danger={false}
        label={t("common.name")}
        name={status.name}
      >
        <h1>{t("statuses.delete_title")}</h1>
        <Flash error={error} />
        <p>{t("statuses.delete_confirm", { name: status.name })}</p>
      </ConfirmForm>
    </Layout>,
  );
