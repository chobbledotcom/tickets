/**
 * Admin holiday management page templates
 */

import { t } from "#i18n";
import {
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Holiday } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  DeleteSection,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { getHolidayFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Shared holidays table used by the holiday settings page and dashboard. */
export const HolidayTable = ({ holidays }: { holidays: Holiday[] }): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>{t("common.name")}</th>
          <th>{t("holidays.col.start_date")}</th>
          <th>{t("holidays.col.end_date")}</th>
        </tr>
      </thead>
      <tbody>
        {holidays.map((holiday) => (
          <tr>
            <td>
              <a href={`/admin/holidays/${holiday.id}/edit`}>{holiday.name}</a>
            </td>
            <td>{holiday.start_date}</td>
            <td>{holiday.end_date}</td>
          </tr>
        ))}
      </tbody>
    </table>,
  );

/**
 * Admin holidays list page
 */
export const adminHolidaysPage = (
  holidays: Holiday[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title={t("terms.holidays")}>
      <AdminNav active="/admin/settings" session={session} />
      <Flash
        {...(successMessage !== undefined ? { success: successMessage } : {})}
      />
      <p class="actions">
        <ActionButton href="/admin/holidays/new" icon="plus">
          {t("holidays.add_holiday")}
        </ActionButton>
        <GuideLink href="/admin/guide#holidays">
          {t("holidays.guide_link")}
        </GuideLink>
      </p>
      {holidays.length === 0 ? (
        <p>{t("holidays.no_holidays")}</p>
      ) : (
        <div class="table-scroll">
          <Raw html={HolidayTable({ holidays })} />
        </div>
      )}
    </Layout>,
  );

/**
 * Holiday create/edit form values
 */
export const holidayToFieldValues = (
  holiday?: Holiday,
): Record<string, string | number | null> =>
  entityToFieldValues(holiday, getHolidayFields(), {});

/**
 * Admin holiday create page
 */
export const adminHolidayNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("holidays.add.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action="/admin/holidays">
        <h1>{t("holidays.add.heading")}</h1>
        <Flash {...(error !== undefined ? { error } : {})} />
        <Raw html={renderFields(getHolidayFields())} />
        <SubmitButton icon="plus">{t("holidays.add.submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin holiday edit page
 */
export const adminHolidayEditPage = (
  holiday: Holiday,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("holidays.edit.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action={`/admin/holidays/${holiday.id}/edit`}>
        <h1>{t("holidays.edit.heading")}</h1>
        <Flash {...(error !== undefined ? { error } : {})} />
        <Raw
          html={renderFields(getHolidayFields(), holidayToFieldValues(holiday))}
        />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      <DeleteSection
        heading={t("common.delete")}
        href={`/admin/holidays/${holiday.id}/delete`}
      >
        {t("holidays.delete.submit")}
      </DeleteSection>
    </Layout>,
  );

/**
 * Admin holiday delete confirmation page
 */
export const adminHolidayDeletePage = (
  holiday: Holiday,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("holidays.delete.heading")}>
      <AdminNav active="/admin/settings" session={session} />
      <ConfirmForm
        action={`/admin/holidays/${holiday.id}/delete`}
        buttonText={t("holidays.delete.submit")}
        danger={false}
        label={t("holidays.delete.confirm_label")}
        name={holiday.name}
      >
        <h1>{t("holidays.delete.heading")}</h1>
        <Flash {...(error !== undefined ? { error } : {})} />
        <p>
          <Raw
            html={t("holidays.delete.confirm", {
              end: holiday.end_date,
              name: escapeHtml(holiday.name),
              start: holiday.start_date,
            })}
          />
        </p>
        <p>{t("holidays.delete.confirm_prompt", { name: holiday.name })}</p>
      </ConfirmForm>
    </Layout>,
  );
