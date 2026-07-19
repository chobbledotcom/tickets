import { t } from "#i18n";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-assignment.ts";
import {
  hostInfraSecretNames,
  type SiteSecretsView,
} from "#shared/site-secrets.ts";
import type { BuiltSiteUpdateState } from "#shared/site-update.ts";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  Icon,
  type IconName,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";

const SiteActionForm = ({
  siteId,
  action,
  children,
}: {
  siteId: number;
  action: string;
  children: Child;
}): JSX.Element => (
  <WritableOnly>
    <CsrfForm action={`/admin/built-sites/${siteId}/${action}`}>
      {children}
    </CsrfForm>
  </WritableOnly>
);

const CodeNameList = ({ names }: { names: string[] }): JSX.Element => (
  <ul>
    {names.map((name) => (
      <li>
        <code>{name}</code>
      </li>
    ))}
  </ul>
);

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

const MonthsInput = ({ id }: { id?: string | undefined }): JSX.Element => (
  <input id={id} max="120" min="1" name="months" type="number" value="1" />
);

type DeadlineFormProps = { site: BuiltSite; inputId?: string };

const deadlineForm =
  (
    action: string,
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

const provisionedPanel = (site: BuiltSite): JSX.Element => {
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

const unprovisionedPanel = (site: BuiltSite): JSX.Element => (
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

export const renewalPanelFor = (site: BuiltSite): JSX.Element =>
  isProvisioned(site) ? provisionedPanel(site) : unprovisionedPanel(site);

export const MaintenancePanel = ({
  site,
}: {
  site: BuiltSite;
}): JSX.Element => (
  <div class="prose">
    <p>{t("built_sites.maintenance_intro")}</p>
    {site.scheduledTaskKey ? (
      <p>
        <strong>{t("built_sites.maintenance_active_key")}</strong>{" "}
        <code>{site.scheduledTaskKey}</code>
      </p>
    ) : (
      <SiteActionForm action="provision-scheduler" siteId={site.id}>
        <SubmitButton icon="hammer">
          {t("built_sites.maintenance_provision")}
        </SubmitButton>
      </SiteActionForm>
    )}
  </div>
);

export const SecretsPanel = ({
  site,
  view,
}: {
  site: BuiltSite;
  view?: SiteSecretsView | undefined;
}): JSX.Element => {
  if (!view) return <p class="prose">{t("built_sites.secrets_unavailable")}</p>;
  if (!view.ok) {
    return (
      <div class="prose">
        <ErrorNote>
          {t("built_sites.secrets_error", { error: view.error })}
        </ErrorNote>
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

export const UpdatePanel = ({
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
