/**
 * The built-site tabs that report on the site itself: its scheduled
 * maintenance, the secrets it carries, and the release it runs.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  hostInfraSecretNames,
  type SiteSecretsView,
} from "#shared/site-secrets.ts";
import type { BuiltSiteUpdateState } from "#shared/site-update.ts";
import type { UptimeKumaMonitorDetails } from "#shared/uptime-kuma/matching.ts";
import type { UptimeKumaMonitorState } from "#shared/uptime-kuma/monitors.ts";
import {
  ConfirmActionButton,
  SiteActionForm,
  TranslatedSubmitButton,
} from "#templates/admin/built-sites/action-forms.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";

const CodeNameList = ({ names }: { names: string[] }): JSX.Element => (
  <ul>
    {names.map((name) => (
      <li>
        <code>{name}</code>
      </li>
    ))}
  </ul>
);

const formatMonitorInterval = (seconds: number): string =>
  seconds % 60 === 0
    ? t("built_sites.kuma_interval_minutes", {
        minutes: String(seconds / 60),
      })
    : t("built_sites.kuma_interval_seconds", { seconds: String(seconds) });

const KumaMonitorDetails = ({
  monitor,
}: {
  monitor: UptimeKumaMonitorDetails;
}): JSX.Element => {
  const details: Array<readonly [string, string]> = [
    ["built_sites.kuma_monitor_id", String(monitor.id)],
    ["built_sites.kuma_monitor_name", monitor.name],
    ["built_sites.kuma_group", monitor.group],
    [
      "built_sites.kuma_status",
      t(
        monitor.active
          ? "built_sites.kuma_status_active"
          : "built_sites.kuma_status_paused",
      ),
    ],
    ["built_sites.kuma_target", monitor.url],
    ["built_sites.kuma_method", monitor.method],
    [
      "built_sites.kuma_interval",
      formatMonitorInterval(monitor.intervalSeconds),
    ],
  ];
  return (
    <dl>
      {details.map(([labelKey, value]) => (
        <div>
          <dt>{t(labelKey)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
};

type MaintenancePanelProps = {
  monitor: UptimeKumaMonitorState;
  site: BuiltSite;
};

const KumaMonitorPanel = ({
  monitor,
  site,
}: MaintenancePanelProps): JSX.Element => {
  if (monitor.kind === "unconfigured") {
    return <p>{t("built_sites.kuma_unconfigured")}</p>;
  }
  if (monitor.kind === "error") {
    return (
      <ErrorNote>
        {t("built_sites.kuma_error", { error: monitor.error })}
      </ErrorNote>
    );
  }
  if (monitor.kind === "found") {
    return <KumaMonitorDetails monitor={monitor.monitor} />;
  }
  return (
    <>
      <p>{t("built_sites.kuma_missing")}</p>
      {site.scheduledTaskKey ? (
        <SiteActionForm action="add-uptime-monitor" siteId={site.id}>
          <TranslatedSubmitButton icon="plus" labelKey="built_sites.kuma_add" />
        </SiteActionForm>
      ) : (
        <p>{t("built_sites.kuma_needs_key")}</p>
      )}
    </>
  );
};

export const MaintenancePanel = ({
  monitor,
  site,
}: MaintenancePanelProps): JSX.Element => (
  <div class="prose">
    <p>{t("built_sites.maintenance_intro")}</p>
    {site.scheduledTaskKey && (
      <p>
        <strong>{t("built_sites.maintenance_site_key")}</strong>{" "}
        <code>{site.scheduledTaskKey}</code>
      </p>
    )}
    <SiteActionForm action="provision-scheduler" siteId={site.id}>
      <TranslatedSubmitButton
        icon="hammer"
        labelKey={
          site.scheduledTaskKey
            ? "built_sites.maintenance_resend"
            : "built_sites.maintenance_provision"
        }
      />
    </SiteActionForm>
    <h3>{t("built_sites.kuma_title")}</h3>
    <KumaMonitorPanel monitor={monitor} site={site} />
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
