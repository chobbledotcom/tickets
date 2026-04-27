/**
 * Admin built sites management page templates
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { builtSiteFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin built sites list page
 */
export const adminBuiltSitesPage = (
  sites: BuiltSite[],
  session: AdminSession,
  successMessage?: string,
): string => {
  const scriptIds = sites
    .filter((site) => site.bunnyScriptId)
    .map((site) => site.bunnyScriptId)
    .join("|");

  return String(
    <Layout title="Built Sites">
      <AdminNav active="/admin/built-sites" session={session} />
      <Flash success={successMessage} />
      <p>
        <a href="/admin/built-sites/new">Add Built Site</a>{" "}
        <a href="/admin/builder">Build New Site</a>
      </p>
      {sites.length === 0 ? (
        <p>No built sites recorded.</p>
      ) : (
        <div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Bunny URL</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr>
                    <td>{site.name}</td>
                    <td>
                      <a href={site.bunnyUrl} rel="noopener" target="_blank">
                        {site.bunnyUrl}
                      </a>
                    </td>
                    <td>
                      {site.assignedAttendeeId
                        ? `Assigned (attendee #${site.assignedAttendeeId})`
                        : site.assignable
                          ? "Available"
                          : "Not assignable"}
                    </td>
                    <td>
                      <a href={`/admin/built-sites/${site.id}/edit`}>Edit</a>{" "}
                      <a href={`/admin/built-sites/${site.id}/delete`}>
                        Delete
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{scriptIds}</p>
        </div>
      )}
    </Layout>,
  );
};

/**
 * Built site create/edit form values
 */
export const builtSiteToFieldValues = (
  site?: BuiltSite,
): Record<string, string | number | null> => ({
  assignable: site?.assignable ? "1" : "",
  bunny_script_id: site?.bunnyScriptId ?? "",
  bunny_url: site?.bunnyUrl ?? "",
  db_token: site?.dbToken ?? "",
  db_url: site?.dbUrl ?? "",
  name: site?.name ?? "",
});

/**
 * Admin built site create page
 */
export const adminBuiltSiteNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Add Built Site">
      <AdminNav active="/admin/built-sites" session={session} />
      <CsrfForm action="/admin/built-sites">
        <h1>Add Built Site</h1>
        <Flash error={error} />
        <Raw html={renderFields(builtSiteFields)} />
        <button type="submit">Create Built Site</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin built site edit page
 */
export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Edit Built Site">
      <AdminNav active="/admin/built-sites" session={session} />
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <h1>Edit Built Site</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(builtSiteFields, builtSiteToFieldValues(site))}
        />
        <button type="submit">Save Changes</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin built site delete confirmation page
 */
export const adminBuiltSiteDeletePage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Delete Built Site">
      <AdminNav active="/admin/built-sites" session={session} />
      <ConfirmForm
        action={`/admin/built-sites/${site.id}/delete`}
        buttonText="Delete Built Site"
        danger={false}
        label="Site name"
        name={site.name}
      >
        <h1>Delete Built Site</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the built site{" "}
          <strong>{site.name}</strong>?
        </p>
        <p>Type the site name "{site.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );
