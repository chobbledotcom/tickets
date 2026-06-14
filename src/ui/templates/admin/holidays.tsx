/**
 * Admin holiday management page templates
 */

import {
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Holiday } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { ActionButton, GuideLink } from "#templates/components/actions.tsx";
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
    <Layout title="Holidays">
      <AdminNav active="/admin/holidays" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        <ActionButton href="/admin/holidays/new" icon="plus">
          Add Holiday
        </ActionButton>
        <GuideLink href="/admin/guide#holidays">Holidays guide</GuideLink>
      </p>
      {holidays.length === 0 ? (
        <p>No holidays configured.</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((holiday) => (
                <tr>
                  <td>{holiday.name}</td>
                  <td>{holiday.start_date}</td>
                  <td>{holiday.end_date}</td>
                  <td>
                    <a href={`/admin/holidays/${holiday.id}/edit`}>Edit</a>{" "}
                    <a href={`/admin/holidays/${holiday.id}/delete`}>Delete</a>
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
): Record<string, string | number | null> =>
  entityToFieldValues(holiday, holidayFields, {});

/**
 * Admin holiday create page
 */
export const adminHolidayNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Add Holiday">
      <AdminNav active="/admin/holidays" session={session} />
      <CsrfForm action="/admin/holidays">
        <h1>Add Holiday</h1>
        <Flash error={error} />
        <Raw html={renderFields(holidayFields)} />
        <button type="submit">Create Holiday</button>
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
    <Layout title="Edit Holiday">
      <AdminNav active="/admin/holidays" session={session} />
      <CsrfForm action={`/admin/holidays/${holiday.id}/edit`}>
        <h1>Edit Holiday</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(holidayFields, holidayToFieldValues(holiday))}
        />
        <button type="submit">Save Changes</button>
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
    <Layout title="Delete Holiday">
      <AdminNav active="/admin/holidays" session={session} />
      <ConfirmForm
        action={`/admin/holidays/${holiday.id}/delete`}
        buttonText="Delete Holiday"
        danger={false}
        label="Holiday name"
        name={holiday.name}
      >
        <h1>Delete Holiday</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the holiday{" "}
          <strong>{holiday.name}</strong> ({holiday.start_date} to{" "}
          {holiday.end_date})?
        </p>
        <p>Type the holiday name "{holiday.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );
