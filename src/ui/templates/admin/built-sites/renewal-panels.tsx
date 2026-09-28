/* jscpd:ignore-start -- imports */
import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  formatDeadlineLabel,
  isProvisioned,
  isReservedRenewal,
} from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-renewal.ts";
import {
  ConfirmActionButton,
  SiteActionForm,
  TranslatedSubmitButton,
} from "#templates/admin/built-sites/action-forms.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";

/* jscpd:ignore-end */

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
      <TranslatedSubmitButton icon="save" labelKey={submitKey} />
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
        <TranslatedSubmitButton
          icon="rotate-ccw"
          labelKey="built_sites.resync_deadline_button"
        />
      </SiteActionForm>
    </ProsePanel>
  );
};

/** The provisioning form: the one way to push and confirm a renewal URL. */
const provisionRenewalForm = (site: BuiltSite): JSX.Element => (
  <>
    <h3>{t("built_sites.provision_renewal_title")}</h3>
    <SiteActionForm action="provision-renewal" siteId={site.id}>
      <label for="provision_months">{t("built_sites.initial_months")}</label>
      <MonthsInput id="provision_months" />
      <TranslatedSubmitButton
        icon="hammer"
        labelKey="built_sites.provision_button"
      />
    </SiteActionForm>
  </>
);

/** The shell both renewal panels share: the deadline readout. */
const deadlinePanel = (
  site: BuiltSite,
  children: JSX.Element[],
): JSX.Element => (
  <ProsePanel
    label={t("built_sites.current_deadline")}
    value={formatDeadlineLabel(site.readOnlyFrom)}
  >
    {children}
  </ProsePanel>
);

const unprovisionedPanel = (site: BuiltSite): JSX.Element =>
  deadlinePanel(site, [
    provisionRenewalForm(site),
    <h3>{t("built_sites.bump_deadline_title")}</h3>,
    <BumpDeadlineForm site={site} />,
    <h3>{t("built_sites.override_deadline_title")}</h3>,
    <OverrideDeadlineForm site={site} />,
  ]);

/** Reserved but unconfirmed: the token's URL push never reached the site, so
 * the only way forward is provisioning again — the route re-pushes the
 * reserved token and the buyer's stamped term. Deadline edits stay out of
 * reach: confirming a cutoff here would make the provision retry refuse
 * while the site still has no renewal link. */
const pendingRenewalPanel = (site: BuiltSite): JSX.Element =>
  deadlinePanel(site, [
    <ErrorNote>{t("built_sites.provision_pending_note")}</ErrorNote>,
    provisionRenewalForm(site),
  ]);

export const renewalPanelFor = (site: BuiltSite): JSX.Element => {
  if (!isProvisioned(site)) return unprovisionedPanel(site);
  if (isReservedRenewal(site)) return pendingRenewalPanel(site);
  return provisionedPanel(site);
};
