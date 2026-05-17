/**
 * Admin built sites management page templates
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-assignment.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { builtSiteFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Tier-event option shape consumed by the renewal panel select inputs. */
export type RenewalTierOption = {
  id: number;
  name: string;
  unit_price: number;
  months_per_unit: number;
};

/**
 * Admin built sites list page
 */
export const adminBuiltSitesPage = (
  sites: BuiltSite[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
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
                    <a href={`/admin/built-sites/${site.id}/delete`}>Delete</a>
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

const renderTierLabel = (te: RenewalTierOption): string =>
  `${te.name} (${te.months_per_unit}mo / ${te.unit_price ? `${te.unit_price}¢` : "free"})`;

type TierSelectProps = {
  id: string;
  tiers: RenewalTierOption[];
  selectedId?: number | null;
};

const TierSelect = ({
  id,
  tiers,
  selectedId,
}: TierSelectProps): JSX.Element => (
  <select id={id} name="tier_event_id">
    {tiers.map((te) => (
      <option selected={te.id === selectedId} value={te.id}>
        {renderTierLabel(te)}
      </option>
    ))}
  </select>
);

type RenewalActionProps = {
  siteId: number;
  action: string;
  children: JSX.Element | JSX.Element[];
};

/** Standard renewal action form wrapper — CSRF + path scoping in one place. */
const RenewalActionForm = ({
  siteId,
  action,
  children,
}: RenewalActionProps): JSX.Element => (
  <CsrfForm action={`/admin/built-sites/${siteId}/${action}`}>
    {children}
  </CsrfForm>
);

const MonthsInput = ({
  id,
  defaultValue = "1",
}: {
  id?: string;
  defaultValue?: string;
}): JSX.Element => (
  <input
    id={id}
    max="120"
    min="1"
    name="months"
    type="number"
    value={defaultValue}
  />
);

const ProvisionedPanel = ({
  site,
  tiers,
}: {
  site: BuiltSite;
  tiers: RenewalTierOption[];
}): JSX.Element => {
  const renewalUrl = site.renewalToken ? renewalUrlFor(site.renewalToken) : "";
  return (
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

      <RenewalActionForm action="set-renewal-tier" siteId={site.id}>
        <label for="tier_event_id">Tier event</label>
        <TierSelect
          id="tier_event_id"
          selectedId={site.renewalTierEventId}
          tiers={tiers}
        />
        <button type="submit">Save tier</button>
      </RenewalActionForm>

      <RenewalActionForm action="rotate-renewal-token" siteId={site.id}>
        <button
          onclick="return confirm('The old URL will stop working. Continue?')"
          type="submit"
        >
          Rotate token
        </button>
      </RenewalActionForm>

      <RenewalActionForm action="bump-deadline" siteId={site.id}>
        <label for="bump_months">Bump deadline by months</label>
        <MonthsInput id="bump_months" />
        <button type="submit">Bump</button>
      </RenewalActionForm>

      <RenewalActionForm action="override-deadline" siteId={site.id}>
        <label for="override_date">Override deadline</label>
        <input id="override_date" name="date" type="date" />
        <button type="submit">Override</button>
      </RenewalActionForm>

      <RenewalActionForm action="re-sync-deadline" siteId={site.id}>
        <button type="submit">Re-sync deadline</button>
      </RenewalActionForm>
    </div>
  );
};

const UnprovisionedPanel = ({
  site,
  tiers,
}: {
  site: BuiltSite;
  tiers: RenewalTierOption[];
}): JSX.Element => (
  <div class="prose">
    <p>
      <strong>Current deadline:</strong>{" "}
      {formatDeadlineLabel(site.readOnlyFrom)}
    </p>

    <h3>Provision renewal</h3>
    <RenewalActionForm action="provision-renewal" siteId={site.id}>
      <label for="provision_tier_event_id">Tier event</label>
      <TierSelect id="provision_tier_event_id" tiers={tiers} />
      <label for="provision_months">Initial months</label>
      <MonthsInput id="provision_months" />
      <button type="submit">Provision</button>
    </RenewalActionForm>

    <h3>Bump deadline</h3>
    <RenewalActionForm action="bump-deadline" siteId={site.id}>
      <MonthsInput />
      <button type="submit">Bump</button>
    </RenewalActionForm>

    <h3>Override deadline</h3>
    <RenewalActionForm action="override-deadline" siteId={site.id}>
      <input name="date" type="date" />
      <button type="submit">Override</button>
    </RenewalActionForm>
  </div>
);

/**
 * Admin built site edit page
 */
export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  tierEvents: RenewalTierOption[],
  error?: string,
): string => {
  const provisioned = isProvisioned(site);

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
        <ProvisionedPanel site={site} tiers={tierEvents} />
      ) : (
        <UnprovisionedPanel site={site} tiers={tierEvents} />
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
