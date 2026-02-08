/**
 * Admin holiday management page templates
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Holiday } from "#lib/types.ts";
import { holidayFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";

/**
 * Admin holidays list page
 */
export const adminHolidaysPage = (
  holidays: Holiday[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Holidays">
      <AdminNav session={session} />
      <h1>Holidays</h1>
      <Raw html={renderError(error)} />
      <p><a href="/admin/holiday/new">Add Holiday</a></p>
      {holidays.length === 0
        ? <p>No holidays configured.</p>
        : (
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
                      <a href={`/admin/holiday/${holiday.id}/edit`}>Edit</a>
                      {" "}
                      <a href={`/admin/holiday/${holiday.id}/delete`}>Delete</a>
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
    <Layout title="Add Holiday">
      <AdminNav session={session} />
      <Breadcrumb href="/admin/holidays" label="Holidays" />
      <h1>Add Holiday</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/holiday">
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(holidayFields)} />
        <button type="submit">Create Holiday</button>
      </form>
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
      <AdminNav session={session} />
      <Breadcrumb href="/admin/holidays" label="Holidays" />
      <h1>Edit Holiday</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action={`/admin/holiday/${holiday.id}/edit`}>
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(holidayFields, holidayToFieldValues(holiday))} />
        <button type="submit">Save Changes</button>
      </form>
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
      <AdminNav session={session} />
      <Breadcrumb href="/admin/holidays" label="Holidays" />
      <h1>Delete Holiday</h1>
      <Raw html={renderError(error)} />
      <p>
        Are you sure you want to delete the holiday <strong>{holiday.name}</strong> ({holiday.start_date} to {holiday.end_date})?
      </p>
      <p>Type the holiday name to confirm:</p>
      <form method="POST" action={`/admin/holiday/${holiday.id}/delete`}>
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <label>
          Holiday Name
          <input type="text" name="confirm_identifier" required />
        </label>
        <button type="submit">Delete Holiday</button>
      </form>
    </Layout>,
  );
