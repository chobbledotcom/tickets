/**
 * Admin built sites management page templates
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { type BuiltSite, DEFAULT_UPDATE_TIER } from "#shared/db/built-sites.ts";
import {
  booleanToCheckbox,
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
/* jscpd:ignore-start */
import { AdminPage, errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
/* jscpd:ignore-end */
import {
  ActionButton,
  Icon,
  type IconName,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { ErrorAlert } from "#templates/components/error-alert.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";
import { getBuiltSiteFields } from "#templates/fields.ts";

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
        <ErrorAlert message={t("built_sites.no_renewal_tier")} />
      </section>
    );
  }
  return (
    <section>
      <h2>{t("built_sites.renewal_tiers_title")}</h2>
      <DataTable
        columns={[
          { header: t("built_sites.tier_table_tier") },
          { class: "quantity", header: t("built_sites.tier_table_months") },
          { class: "amount", header: t("built_sites.tier_table_price") },
          { class: "quantity", header: t("built_sites.tier_table_units") },
        ]}
        rows={tiers.map((tier) => [
          <a href={`/admin/listing/${tier.id}`}>{tier.name}</a>,
          tier.months_per_unit,
          formatCurrency(tier.unit_price),
          tier.attendee_count,
        ])}
      />
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
  const hostingIds = sites
    .filter((site) => site.hostingId && site.hostingProvider === "bunny")
    .map((site) => site.hostingId)
    .join("|");

  return String(
    <AdminPage
      active="/admin/settings"
      session={session}
      title={t("built_sites.list_title")}
    >
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
          <DataTable
            columns={[
              { header: t("common.name") },
              { header: t("built_sites.table_site_url") },
              { header: t("common.status") },
              { header: t("built_sites.table_updates") },
              { header: t("built_sites.table_read_only") },
            ]}
            rows={sites.map((site) => [
              <a href={`/admin/built-sites/${site.id}/edit`}>{site.name}</a>,
              <a href={site.siteUrl} rel="noopener" target="_blank">
                {site.siteUrl}
              </a>,
              site.assignedAttendeeId
                ? t("built_sites.status_assigned", {
                    id: site.assignedAttendeeId,
                  })
                : site.assignable
                  ? t("built_sites.status_available")
                  : t("built_sites.status_not_assignable"),
              site.updates,
              formatDeadlineLabel(site.readOnlyFrom),
            ])}
          />
          <p>{hostingIds}</p>
        </div>
      )}
      <RenewalTierSummary tiers={renewalTiers} />
    </AdminPage>,
  );
};

/**
 * Built site create/edit form values
 */
export const builtSiteToFieldValues = (
  site?: BuiltSite,
): Record<string, string | number | null> => ({
  assignable: booleanToCheckbox(!!site?.assignable),
  db_provider: site?.dbProvider ?? "bunny",
  db_token: site?.dbToken ?? "",
  db_url: site?.dbUrl ?? "",
  hosting_id: site?.hostingId ?? "",
  hosting_provider: site?.hostingProvider ?? "bunny",
  name: site?.name ?? "",
  site_url: site?.siteUrl ?? "",
  updates: site?.updates ?? DEFAULT_UPDATE_TIER,
});

/**
 * Admin built site create page
 */
export const adminBuiltSiteNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  errorAdminPage(t("built_sites.add_site_title"), "/admin/settings")(
    session,
    error,
  )(
    <NewResourceForm
      action="/admin/built-sites"
      fieldsHtml={renderFields(getBuiltSiteFields())}
      submitLabel={t("built_sites.create_built_site_button")}
      title={t("built_sites.add_site_title")}
    />,
  );

type SiteActionProps = {
  siteId: number;
  action: string;
  children: Child;
};

/** `<div class="prose"><p><strong>{label}</strong> {value}</p>…children</div>` —
 *  the shared shell of the deadline/update panels: a labelled prose header
 *  paragraph followed by the rest of the panel content. */
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

/** A `<ul>` of `<li><code>name</code></li>` for the secrets panel's
 *  missing/present secret lists. */
const CodeNameList = ({ names }: { names: string[] }): JSX.Element => (
  <ul>
    {names.map((name) => (
      <li>
        <code>{name}</code>
      </li>
    ))}
  </ul>
);

/** A confirm-button submit form: the same `confirm('…')` guard + Icon + label
 *  pattern the rotate-renewal-token and update actions share. */
const ConfirmActionButton = ({
  action,
  confirmKey,
  icon,
  labelKey,
  siteId,
}: {
  action: string;
  confirmKey: string;
  icon: IconName;
  labelKey: string;
  siteId: number;
}): JSX.Element => (
  <SiteActionForm action={action} siteId={siteId}>
    <button onclick={`return confirm('${t(confirmKey)}')`} type="submit">
      <Icon name={icon} />
      <span>{t(labelKey)}</span>
    </button>
  </SiteActionForm>
);

const MonthsInput = ({
  id,
  defaultValue = "1",
}: {
  id?: string | undefined;
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

/** Curried deadline form: caller specialises the action, the field element,
 *  its label translation key, and the submit label; the shared shell renders
 *  the {@link SiteActionForm} wrapper, the optional `<label for>`, the field,
 *  and the submit button. Used by BumpDeadlineForm and OverrideDeadlineForm. */
const deadlineForm =
  (
    action: Parameters<typeof SiteActionForm>[0]["action"],
    field: (inputId?: string) => JSX.Element,
    labelKey: string,
    submitKey: string,
  ): ((props: DeadlineFormProps) => JSX.Element) =>
  ({ site, inputId }: DeadlineFormProps): JSX.Element => (
    <SiteActionForm action={action} siteId={site.id}>
      {inputId ? <label for={inputId}>{t(labelKey)}</label> : null}
      {field(inputId)}
      <SubmitButton icon="save">{t(submitKey)}</SubmitButton>
    </SiteActionForm>
  );

const BumpDeadlineForm = deadlineForm(
  "bump-deadline",
  (inputId) => <MonthsInput id={inputId} />,
  "built_sites.bump_deadline_label",
  "built_sites.bump_deadline_button",
);

const OverrideDeadlineForm = deadlineForm(
  "override-deadline",
  (inputId) => <input id={inputId} name="date" type="date" />,
  "built_sites.override_deadline_label",
  "built_sites.override_deadline_button",
);

const ProvisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => {
  const renewalUrl = renewalUrlFor(site.renewalToken!);
  return (
    <ProsePanel
      label={t("built_sites.current_deadline")}
      value={
        <>
          {formatDeadlineLabel(site.readOnlyFrom)}
          {site.readOnlyFrom && (
            <Raw
              html={`<details><summary>${t(
                "built_sites.raw_iso",
              )}</summary><code>${site.readOnlyFrom}</code></details>`}
            />
          )}
        </>
      }
    >
      <p>
        <strong>{t("built_sites.renewal_url")}</strong>{" "}
        <code>{renewalUrl}</code>
      </p>

      <ConfirmActionButton
        action="rotate-renewal-token"
        confirmKey="built_sites.rotate_token_confirm"
        icon="rotate-ccw"
        labelKey="built_sites.rotate_token"
        siteId={site.id}
      />

      <BumpDeadlineForm inputId="bump_months" site={site} />

      <OverrideDeadlineForm inputId="override_date" site={site} />

      <SiteActionForm action="re-sync-deadline" siteId={site.id}>
        <SubmitButton icon="rotate-ccw">
          {t("built_sites.resync_deadline_button")}
        </SubmitButton>
      </SiteActionForm>
    </ProsePanel>
  );
};

const UnprovisionedPanel = ({ site }: { site: BuiltSite }): JSX.Element => (
  <ProsePanel
    label={t("built_sites.current_deadline")}
    value={formatDeadlineLabel(site.readOnlyFrom)}
  >
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
  </ProsePanel>
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
  view?: SiteSecretsView | undefined;
}): JSX.Element => {
  if (!view) {
    return <p class="prose">{t("built_sites.secrets_unavailable")}</p>;
  }
  if (!view.ok) {
    return (
      <div class="prose">
        <ErrorAlert
          message={t("built_sites.secrets_error", { error: view.error })}
        />
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
          <CodeNameList names={view.missing} />
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
          <CodeNameList names={view.present} />
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
  <ProsePanel
    label={t("built_sites.update_site_version_label")}
    value={
      state.siteVersionLabel ??
      (state.siteVersionError
        ? t("built_sites.update_version_error", {
            error: state.siteVersionError,
          })
        : t("built_sites.update_unknown_version"))
    }
  >
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
    {state.providerConfigured && state.hasHostingId ? (
      <ConfirmActionButton
        action="update"
        confirmKey="built_sites.update_confirm"
        icon="rotate-ccw"
        labelKey="built_sites.update_button"
        siteId={site.id}
      />
    ) : (
      <p>
        <em>{t("built_sites.update_unavailable")}</em>
      </p>
    )}
  </ProsePanel>
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
    <AdminPage
      active="/admin/settings"
      session={session}
      title={t("built_sites.edit_site_title")}
    >
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <h1>{t("built_sites.edit_site_title")}</h1>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(
            getBuiltSiteFields(),
            builtSiteToFieldValues(site),
          )}
        />
        {SaveChangesButton()}
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
    </AdminPage>,
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
  ConfirmPage({
    action: `/admin/built-sites/${site.id}/delete`,
    active: "/admin/settings",
    buttonText: t("built_sites.delete_built_site_button"),
    children: (
      <>
        <h1>{t("built_sites.delete_page_title")}</h1>
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
      </>
    ),
    danger: false,
    error,
    label: t("built_sites.delete_label"),
    name: site.name,
    session,
    title: t("built_sites.delete_page_title"),
  });
