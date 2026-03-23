/**
 * Admin holiday management page templates
 */

import { t } from "#i18n";
import {
  CsrfForm,
  renderError,
  renderFields,
  renderSuccess,
} from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Holiday } from "#lib/types.ts";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { holidayFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin holidays list page
 */
export const adminHolidaysPage = (
  holidays: Holiday[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title={t("holidays.heading")}>
      <AdminNav session={session} active="/admin/holidays" />
      <h1>{t("holidays.heading")}</h1>
      <Raw html={renderSuccess(successMessage)} />
      <p>
        <a href="/admin/holiday/new">{t("holidays.add_holiday")}</a>
      </p>
      {holidays.length === 0 ? (
        <p>{t("holidays.no_holidays")}</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("holidays.col.name")}</th>
                <th>{t("holidays.col.start_date")}</th>
                <th>{t("holidays.col.end_date")}</th>
                <th>{t("holidays.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((holiday) => (
                <tr>
                  <td>{holiday.name}</td>
                  <td>{holiday.start_date}</td>
                  <td>{holiday.end_date}</td>
                  <td>
                    <a href={`/admin/holiday/${holiday.id}/edit`}>
                      {t("holidays.edit")}
                    </a>{" "}
                    <a href={`/admin/holiday/${holiday.id}/delete`}>
                      {t("holidays.delete")}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
  );

/**
 * Holiday create/edit form values
 */
export const holidayToFieldValues = (
  holiday?: Holiday,
): Record<string, string | number | null> => ({
  name: holiday?.name ?? "",
  start_date: holiday?.start_date ?? "",
  end_date: holiday?.end_date ?? "",
});

/**
 * Admin holiday create page
 */
export const adminHolidayNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("holidays.add.title")}>
      <AdminNav session={session} active="/admin/holidays" />
      <Breadcrumb href="/admin/holidays" label={t("holidays.heading")} />
      <h1>{t("holidays.add.heading")}</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/holiday">
        <Raw html={renderFields(holidayFields)} />
        <button type="submit">{t("holidays.add.submit")}</button>
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
      <AdminNav session={session} active="/admin/holidays" />
      <Breadcrumb href="/admin/holidays" label={t("holidays.heading")} />
      <h1>{t("holidays.edit.heading")}</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action={`/admin/holiday/${holiday.id}/edit`}>
        <Raw
          html={renderFields(holidayFields, holidayToFieldValues(holiday))}
        />
        <button type="submit">{t("holidays.edit.submit")}</button>
      </CsrfForm>
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
      <AdminNav session={session} active="/admin/holidays" />
      <Breadcrumb href="/admin/holidays" label={t("holidays.heading")} />
      <h1>{t("holidays.delete.heading")}</h1>
      <Raw html={renderError(error)} />
      <p>
        {t("holidays.delete.confirm", {
          name: holiday.name,
          start: holiday.start_date,
          end: holiday.end_date,
        })}
      </p>
      <p>{t("holidays.delete.confirm_prompt")}</p>
      <CsrfForm action={`/admin/holiday/${holiday.id}/delete`}>
        <label>
          {t("holidays.delete.confirm_label")}
          <input type="text" name="confirm_identifier" required />
        </label>
        <button type="submit">{t("holidays.delete.submit")}</button>
      </CsrfForm>
    </Layout>,
  );
