/**
 * Admin built sites management page templates
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { type Child, escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-assignment.ts";
import {
  hostInfraSecretNames,
  type SiteSecretsView,
} from "#shared/site-secrets.ts";
import type { BuiltSiteUpdateState } from "#shared/site-update.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  Icon,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { getBuiltSiteFields } from "#templates/fields.ts";
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
        <h2>{t("built_sites.renewal_tiers_title")}</h2>
        <div class="error" role="alert">
          <Raw html={t("built_sites.no_renewal_tier")} />
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2>{t("built_sites.renewal_tiers_title")}</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("built_sites.tier_table_tier")}</th>
              <th>{t("built_sites.tier_table_months")}</th>
              <th>{t("built_sites.tier_table_price")}</th>
              <th>{t("built_sites.tier_table_units")}</th>
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
    <Layout title={t("built_sites.list_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <Flash success={successMessage} />
      <p class="actions">
        <ActionButton href="/admin/built-sites/new" icon="plus">
          {t("built_sites.add_built_site")}
        </ActionButton>
        <ActionButton href="/admin/builder" icon="hammer" variant="secondary">
          {t("built_sites.build_new_site")}
        </ActionButton>
      </p>
      {sites.length === 0 ? (
        <p>{t("built_sites.no_built_sites")}</p>
      ) : (
        <div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("common.name")}</th>
                  <th>{t("built_sites.table_bunny_url")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("built_sites.table_read_only")}</th>
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
                        ? t("built_sites.status_assigned", {
                            id: site.assignedAttendeeId,
                          })
                        : site.assignable
                          ? t("built_sites.status_available")
                          : t("built_sites.status_not_assignable")}
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
    <Layout title={t("built_sites.add_site_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action="/admin/built-sites">
        <h1>{t("built_sites.add_site_title")}</h1>
        <Flash error={error} />
        <Raw html={renderFields(getBuiltSiteFields())} />
        <SubmitButton icon="plus">
          {t("built_sites.create_built_site_button")}
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );

type SiteActionProps = {
  siteId: number;
  action: string;
  children: Child;
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

type DeadlineFormProps = { site: BuiltSite; inputId?: string };

/**
 * Bump-deadline form, shared by the provisioned and unprovisioned panels.
 * Pass `inputId` to render an inline label (provisioned); omit it when a
 * surrounding heading already labels the field (unprovisioned).
 */
const BumpDeadlineForm = ({
  site,
  inputId,
}: DeadlineFormProps): JSX.Element => (
  <SiteActionForm action="bump-deadline" siteId={site.id}>
    {inputId ? (
      <label for={inputId}>{t("built_sites.bump_deadline_label")}</label>
    ) : null}
    <MonthsInput id={inputId} />
    <SubmitButton icon="save">
      {t("built_sites.bump_deadline_button")}
    </SubmitButton>
  </SiteActionForm>
);

/**
 * Override-deadline form, shared by both panels. See {@link BumpDeadlineForm}
 * for the `inputId` labelling convention.
 */
const OverrideDeadlineForm = ({
  site,
  inputId,
}: DeadlineFormProps): JSX.Element => (
  <SiteActionForm action="override-deadline" siteId={site.id}>
    {inputId ? (
      <label for={inputId}>{t("built_sites.override_deadline_label")}</label>
    ) : null}
    <input id={inputId} name="date" type="date" />
    <SubmitButton icon="save">
      {t("built_sites.override_deadline_button")}
    </SubmitButton>
  </SiteActionForm>
);

const ProvisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => {
  const renewalUrl = renewalUrlFor(site.renewalToken!);
  return (
    <div class="prose">
      <p>
        <strong>{t("built_sites.current_deadline")}</strong>{" "}
        {formatDeadlineLabel(site.readOnlyFrom)}
        {site.readOnlyFrom && (
          <Raw
            html={`<details><summary>${t(
              "built_sites.raw_iso",
            )}</summary><code>${site.readOnlyFrom}</code></details>`}
          />
        )}
      </p>
      <p>
        <strong>{t("built_sites.renewal_url")}</strong>{" "}
        <code>{renewalUrl}</code>
      </p>

      <SiteActionForm action="rotate-renewal-token" siteId={site.id}>
        <button
          onclick={`return confirm('${t("built_sites.rotate_token_confirm")}')`}
          type="submit"
        >
          <Icon name="rotate-ccw" />
          <span>{t("built_sites.rotate_token")}</span>
        </button>
      </SiteActionForm>

      <BumpDeadlineForm inputId="bump_months" site={site} />

      <OverrideDeadlineForm inputId="override_date" site={site} />

      <SiteActionForm action="re-sync-deadline" siteId={site.id}>
        <SubmitButton icon="rotate-ccw">
          {t("built_sites.resync_deadline_button")}
        </SubmitButton>
      </SiteActionForm>
    </div>
  );
};

const UnprovisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => (
  <div class="prose">
    <p>
      <strong>{t("built_sites.current_deadline")}</strong>{" "}
      {formatDeadlineLabel(site.readOnlyFrom)}
    </p>

    <h3>{t("built_sites.provision_renewal_title")}</h3>
    <SiteActionForm action="provision-renewal" siteId={site.id}>
      <label for="provision_months">{t("built_sites.initial_months")}</label>
      <MonthsInput id="provision_months" />
      <SubmitButton icon="hammer">
        {t("built_sites.provision_button")}
      </SubmitButton>
    </SiteActionForm>

    <h3>{t("built_sites.bump_deadline_title")}</h3>
    <BumpDeadlineForm site={site} />

    <h3>{t("built_sites.override_deadline_title")}</h3>
    <OverrideDeadlineForm site={site} />
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
    return <p class="prose">{t("built_sites.secrets_unavailable")}</p>;
  }
  if (!view.ok) {
    return (
      <div class="prose">
        <div class="error" role="alert">
          <Raw html={t("built_sites.secrets_error", { error: view.error })} />
        </div>
      </div>
    );
  }
  const infraMissing = hostInfraSecretNames(view.missing);
  return (
    <div class="prose">
      <p>
        <Raw
          html={t("built_sites.secrets_count", {
            expected: String(view.expected.length),
            present: String(view.present.length),
          })}
        />
      </p>
      {view.missing.length === 0 ? (
        <output class="success">{t("built_sites.all_secrets_present")}</output>
      ) : (
        <SiteActionForm action="add-secrets" siteId={site.id}>
          <p>{t("built_sites.missing_secrets")}</p>
          <ul>
            {view.missing.map((name) => (
              <li>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          {infraMissing.length > 0 && (
            <p role="note">
              <strong>{t("built_sites.infra_secrets_heading")}</strong>{" "}
              {t("built_sites.infra_secrets_note", {
                names: infraMissing.join(", "),
              })}
            </p>
          )}
          <SubmitButton icon="plus">
            {t("built_sites.set_missing_secrets", {
              count: String(view.missing.length),
            })}
          </SubmitButton>
        </SiteActionForm>
      )}
      {view.present.length > 0 && (
        <details>
          <summary>{t("built_sites.secrets_on_site")}</summary>
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
 * Update panel: shows the version the site reported (read through its read-only
 * database keys) against the latest release the host knows about, and a button
 * that deploys the latest release to the site — the same process as our own
 * self-update, just targeting the site's edge script.
 */
const UpdatePanel = ({
  site,
  state,
}: {
  site: BuiltSite;
  state: BuiltSiteUpdateState;
}): JSX.Element => (
  <div class="prose">
    <p>
      <strong>{t("built_sites.update_site_version_label")}</strong>{" "}
      {state.siteVersionLabel ??
        (state.siteVersionError
          ? t("built_sites.update_version_error", {
              error: state.siteVersionError,
            })
          : t("built_sites.update_unknown_version"))}
    </p>
    <p>
      <strong>{t("built_sites.update_latest_label")}</strong>{" "}
      {state.latestVersion
        ? `${state.latestVersionName} (${state.latestVersion})`
        : t("built_sites.update_latest_none")}
    </p>
    {state.updateAvailable ? (
      <p>
        <strong>{t("built_sites.update_available")}</strong>
      </p>
    ) : state.upToDate ? (
      <output class="success">{t("built_sites.update_up_to_date")}</output>
    ) : null}
    {state.bunnyConfigured && state.hasScriptId ? (
      <SiteActionForm action="update" siteId={site.id}>
        <button
          onclick={`return confirm('${t("built_sites.update_confirm")}')`}
          type="submit"
        >
          <Icon name="rotate-ccw" />
          <span>{t("built_sites.update_button")}</span>
        </button>
      </SiteActionForm>
    ) : (
      <p>
        <em>{t("built_sites.update_unavailable")}</em>
      </p>
    )}
  </div>
);

/**
 * Admin built site edit page
 */
export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
  success?: string,
  secretsView?: SiteSecretsView,
  updateState?: BuiltSiteUpdateState,
): string => {
  const provisioned = isProvisioned(site);

  return String(
    <Layout title={t("built_sites.edit_site_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <h1>{t("built_sites.edit_site_title")}</h1>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(
            getBuiltSiteFields(),
            builtSiteToFieldValues(site),
          )}
        />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>

      <h2>{t("built_sites.renewal_title")}</h2>
      {provisioned ? (
        <ProvisionedPanel site={site} />
      ) : (
        <UnprovisionedPanel site={site} />
      )}

      <h2>{t("built_sites.secrets_title")}</h2>
      <SecretsPanel site={site} view={secretsView} />

      {updateState && (
        <>
          <h2>{t("built_sites.update_title")}</h2>
          <UpdatePanel site={site} state={updateState} />
        </>
      )}

      <h2>{t("common.delete")}</h2>
      <p class="prose">
        <ActionButton
          href={`/admin/built-sites/${site.id}/delete`}
          icon="trash-2"
          variant="secondary"
        >
          {t("built_sites.delete_this_site")}
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
    <Layout title={t("built_sites.delete_page_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <ConfirmForm
        action={`/admin/built-sites/${site.id}/delete`}
        buttonText={t("built_sites.delete_built_site_button")}
        danger={false}
        label={t("built_sites.delete_label")}
        name={site.name}
      >
        <h1>{t("built_sites.delete_page_title")}</h1>
        <Flash error={error} />
        <p>
          <Raw
            html={t("built_sites.delete_confirmation", {
              name: escapeHtml(site.name),
            })}
          />
        </p>
        <p>
          {t("built_sites.delete_confirmation_prompt", { name: site.name })}
        </p>
      </ConfirmForm>
    </Layout>,
  );
