/**
 * Admin built sites management page templates
 */

import { formatCurrency } from "#shared/currency.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-assignment.ts";
import type { SiteSecretsView } from "#shared/site-secrets.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  Icon,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { builtSiteFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Renewal tier summary row rendered beneath the built-sites table. */
const RenewalTierSummary = ({
  tiers,
}: {
  tiers: ListingWithCount[];
}): JSX.Element => {
  if (tiers.length === 0) {
    return (
      <section>
        <h2>Renewal tiers</h2>
        <div class="error" role="alert">
          No renewal tier listing is configured. Customers won't be able to
          renew their sites until you create one (a purchase-only, hidden
          listing with <em>Months Per Unit</em> &gt; 0).
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2>Renewal tiers</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Months per unit</th>
              <th>Unit price</th>
              <th>Units sold</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr>
                <td>
                  <a href={`/admin/listing/${tier.id}`}>{tier.name}</a>
                </td>
                <td>{tier.months_per_unit}</td>
                <td>{formatCurrency(tier.unit_price)}</td>
                <td>{tier.attendee_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

/**
 * Admin built sites list page
 */
export const adminBuiltSitesPage = (
  sites: BuiltSite[],
  session: AdminSession,
  successMessage?: string,
  renewalTiers: ListingWithCount[] = [],
): string => {
  const scriptIds = sites
    .filter((site) => site.bunnyScriptId)
    .map((site) => site.bunnyScriptId)
    .join("|");

  return String(
    <Layout title="Built Sites">
      <AdminNav active="/admin/built-sites" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        <ActionButton href="/admin/built-sites/new" icon="plus">
          Add Built Site
        </ActionButton>
        <ActionButton href="/admin/builder" icon="hammer" variant="secondary">
          Build New Site
        </ActionButton>
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
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr>
                    <td>
                      <a href={`/admin/built-sites/${site.id}/edit`}>
                        {site.name}
                      </a>
                    </td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{scriptIds}</p>
        </div>
      )}
      <RenewalTierSummary tiers={renewalTiers} />
    </Layout>,
  );
};

/**
 * Built site create/edit form values
 */
export const builtSiteToFieldValues = (
  site?: BuiltSite,
): Record<string, string | number | null> => ({
  assignable: booleanToCheckbox(!!site?.assignable),
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
        <SubmitButton icon="plus">Create Built Site</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

type SiteActionProps = {
  siteId: number;
  action: string;
  children: JSX.Element | JSX.Element[];
};

/** Standard built-site action form wrapper — CSRF + path scoping in one place. */
const SiteActionForm = ({
  siteId,
  action,
  children,
}: SiteActionProps): JSX.Element => (
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

const ProvisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => {
  const renewalUrl = renewalUrlFor(site.renewalToken!);
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

      <SiteActionForm action="rotate-renewal-token" siteId={site.id}>
        <button
          onclick="return confirm('The old URL will stop working. Continue?')"
          type="submit"
        >
          <Icon name="rotate-ccw" />
          <span>Rotate token</span>
        </button>
      </SiteActionForm>

      <SiteActionForm action="bump-deadline" siteId={site.id}>
        <label for="bump_months">Bump deadline by months</label>
        <MonthsInput id="bump_months" />
        <SubmitButton icon="save">Bump</SubmitButton>
      </SiteActionForm>

      <SiteActionForm action="override-deadline" siteId={site.id}>
        <label for="override_date">Override deadline</label>
        <input id="override_date" name="date" type="date" />
        <SubmitButton icon="save">Override</SubmitButton>
      </SiteActionForm>

      <SiteActionForm action="re-sync-deadline" siteId={site.id}>
        <SubmitButton icon="rotate-ccw">Re-sync deadline</SubmitButton>
      </SiteActionForm>
    </div>
  );
};

const UnprovisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => (
  <div class="prose">
    <p>
      <strong>Current deadline:</strong>{" "}
      {formatDeadlineLabel(site.readOnlyFrom)}
    </p>

    <h3>Provision renewal</h3>
    <SiteActionForm action="provision-renewal" siteId={site.id}>
      <label for="provision_months">Initial months</label>
      <MonthsInput id="provision_months" />
      <SubmitButton icon="hammer">Provision</SubmitButton>
    </SiteActionForm>

    <h3>Bump deadline</h3>
    <SiteActionForm action="bump-deadline" siteId={site.id}>
      <MonthsInput />
      <SubmitButton icon="save">Bump</SubmitButton>
    </SiteActionForm>

    <h3>Override deadline</h3>
    <SiteActionForm action="override-deadline" siteId={site.id}>
      <input name="date" type="date" />
      <SubmitButton icon="save">Override</SubmitButton>
    </SiteActionForm>
  </div>
);

/**
 * Secrets panel: diffs the secrets we copy to freshly built sites against the
 * ones live on this site's edge script, and offers to backfill the missing
 * ones. Existing secrets are never shown as actionable — they are left
 * untouched.
 */
const SecretsPanel = ({
  site,
  view,
}: {
  site: BuiltSite;
  view?: SiteSecretsView;
}): JSX.Element => {
  if (!view) {
    return <p class="prose">Secrets status is unavailable.</p>;
  }
  if (!view.ok) {
    return (
      <div class="prose">
        <div class="error" role="alert">
          {view.error}
        </div>
      </div>
    );
  }
  return (
    <div class="prose">
      <p>
        This site has <strong>{String(view.present.length)}</strong> secret(s)
        set. We copy <strong>{String(view.expected.length)}</strong> secret(s)
        to freshly built sites.
      </p>
      {view.missing.length === 0 ? (
        <div class="success" role="status">
          All expected secrets are present on this site.
        </div>
      ) : (
        <SiteActionForm action="add-secrets" siteId={site.id}>
          <p>
            Missing from this site (existing secrets are never overwritten):
          </p>
          <ul>
            {view.missing.map((name) => (
              <li>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <SubmitButton icon="plus">
            Set {String(view.missing.length)} missing secret(s)
          </SubmitButton>
        </SiteActionForm>
      )}
      {view.present.length > 0 && (
        <details>
          <summary>Secrets currently on this site</summary>
          <ul>
            {view.present.map((name) => (
              <li>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/**
 * Admin built site edit page
 */
export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
  success?: string,
  secretsView?: SiteSecretsView,
): string => {
  const provisioned = isProvisioned(site);

  return String(
    <Layout title="Edit Built Site">
      <AdminNav active="/admin/built-sites" session={session} />
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <h1>Edit Built Site</h1>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(builtSiteFields, builtSiteToFieldValues(site))}
        />
        <SubmitButton icon="save">Save Changes</SubmitButton>
      </CsrfForm>

      <h2>Renewal</h2>
      {provisioned ? (
        <ProvisionedPanel site={site} />
      ) : (
        <UnprovisionedPanel site={site} />
      )}

      <h2>Secrets</h2>
      <SecretsPanel site={site} view={secretsView} />

      <h2>Delete</h2>
      <p class="prose">
        <ActionButton
          href={`/admin/built-sites/${site.id}/delete`}
          icon="trash-2"
          variant="secondary"
        >
          Delete this site
        </ActionButton>
      </p>
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
