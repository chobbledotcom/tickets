/**
 * Admin built sites management page templates
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
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
                  <th>Read-only from</th>
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
                    <td>{formatDeadlineLabel(site.readOnlyFrom)}</td>
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
  tierEvents: {
    id: number;
    name: string;
    unit_price: number;
    months_per_unit: number;
  }[],
  error?: string,
): string => {
  const provisioned = isProvisioned(site);
  const renewalUrl = site.renewalTokenIndex
    ? `https://${typeof globalThis !== "undefined" ? (location?.host ?? "localhost") : "localhost"}/renew/?t=<token>`
    : "";

  return String(
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

      <h2>Renewal</h2>
      {provisioned ? (
        <div class="prose">
          <p>
            <strong>Current deadline:</strong>{" "}
            {formatDeadlineLabel(site.readOnlyFrom)}
            {site.readOnlyFrom && (
              <Raw
                html={`<details><summary>Raw ISO</summary><code>${site.readOnlyFrom}</code></details>`}
              />
            )}
          </p>
          <p>
            <strong>Renewal URL:</strong> <code>{renewalUrl}</code>
          </p>

          <CsrfForm action={`/admin/built-sites/${site.id}/set-renewal-tier`}>
            <label for="tier_event_id">Tier event</label>
            <select id="tier_event_id" name="tier_event_id">
              {tierEvents.map((te) => (
                <option
                  selected={te.id === site.renewalTierEventId}
                  value={te.id}
                >
                  {te.name} ({te.months_per_unit}mo /{" "}
                  {te.unit_price ? `${te.unit_price}¢` : "free"})
                </option>
              ))}
            </select>
            <button type="submit">Save tier</button>
          </CsrfForm>

          <CsrfForm
            action={`/admin/built-sites/${site.id}/rotate-renewal-token`}
          >
            <button
              onclick="return confirm('The old URL will stop working. Continue?')"
              type="submit"
            >
              Rotate token
            </button>
          </CsrfForm>

          <CsrfForm action={`/admin/built-sites/${site.id}/bump-deadline`}>
            <label for="bump_months">Bump deadline by months</label>
            <input
              id="bump_months"
              max="120"
              min="1"
              name="months"
              type="number"
              value="1"
            />
            <button type="submit">Bump</button>
          </CsrfForm>

          <CsrfForm action={`/admin/built-sites/${site.id}/override-deadline`}>
            <label for="override_date">Override deadline</label>
            <input id="override_date" name="date" type="date" />
            <button type="submit">Override</button>
          </CsrfForm>

          <CsrfForm action={`/admin/built-sites/${site.id}/re-sync-deadline`}>
            <button type="submit">Re-sync deadline</button>
          </CsrfForm>
        </div>
      ) : (
        <div class="prose">
          <p>
            <strong>Current deadline:</strong>{" "}
            {formatDeadlineLabel(site.readOnlyFrom)}
          </p>

          <h3>Provision renewal</h3>
          <CsrfForm action={`/admin/built-sites/${site.id}/provision-renewal`}>
            <label for="provision_tier_event_id">Tier event</label>
            <select id="provision_tier_event_id" name="tier_event_id">
              {tierEvents.map((te) => (
                <option value={te.id}>
                  {te.name} ({te.months_per_unit}mo /{" "}
                  {te.unit_price ? `${te.unit_price}¢` : "free"})
                </option>
              ))}
            </select>
            <label for="provision_months">Initial months</label>
            <input
              id="provision_months"
              max="120"
              min="1"
              name="months"
              type="number"
              value="1"
            />
            <button type="submit">Provision</button>
          </CsrfForm>

          <h3>Bump deadline</h3>
          <CsrfForm action={`/admin/built-sites/${site.id}/bump-deadline`}>
            <input max="120" min="1" name="months" type="number" value="1" />
            <button type="submit">Bump</button>
          </CsrfForm>

          <h3>Override deadline</h3>
          <CsrfForm action={`/admin/built-sites/${site.id}/override-deadline`}>
            <input name="date" type="date" />
            <button type="submit">Override</button>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );
};

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
