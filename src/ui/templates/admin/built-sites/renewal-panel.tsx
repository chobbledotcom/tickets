/**
 * The Renewal tab: the tier this site renews on, plus the deadline and token
 * actions that keep its read-only date in step with the site itself.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  formatDeadlineLabel,
  isProvisioned,
  type SiteRenewalTier,
  siteRenewalTier,
} from "#shared/renewal-helpers.ts";
import { renewalUrlFor } from "#shared/site-assignment.ts";
import {
  ConfirmActionButton,
  SiteActionForm,
  TranslatedSubmitButton,
} from "#templates/admin/built-sites/action-forms.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import type { ListingWithCount } from "#types";

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

type TierSectionProps = { site: BuiltSite; tiers: ListingWithCount[] };

/** The one way a tier is named to an operator, in the summary and the picker. */
const renewalTierLabel = (tier: ListingWithCount): string =>
  t("built_sites.renewal_tier_option", {
    months: String(tier.months_per_unit),
    name: tier.name,
    price: formatCurrency(tier.unit_price),
  });

/** A retired tier keeps its stored id but no longer picks itself, so the form
 * shows the same "any tier" choice the customer is really getting. */
const chosenTierValue = (chosen: SiteRenewalTier<ListingWithCount>): string =>
  chosen.kind === "pinned" ? String(chosen.tier.id) : "";

const RenewalTierForm = ({
  chosen,
  site,
  tiers,
}: TierSectionProps & {
  chosen: SiteRenewalTier<ListingWithCount>;
}): JSX.Element => (
  <SiteActionForm action="set-renewal-tier" siteId={site.id}>
    <label for="renewal_tier">{t("built_sites.renewal_tier_label")}</label>
    <SelectField
      id="renewal_tier"
      name="tier_id"
      options={[
        { label: t("built_sites.renewal_tier_any"), value: "" },
        ...tiers.map((tier) => ({
          label: renewalTierLabel(tier),
          value: String(tier.id),
        })),
      ]}
      value={chosenTierValue(chosen)}
    />
    <TranslatedSubmitButton
      icon="save"
      labelKey="built_sites.renewal_tier_button"
    />
  </SiteActionForm>
);

const RenewalTierSection = ({ site, tiers }: TierSectionProps): JSX.Element => {
  const chosen = siteRenewalTier(site, tiers);
  return (
    <>
      <h3>{t("built_sites.renewal_tier_title")}</h3>
      <p>
        <strong>{t("built_sites.renewal_tier_current")}</strong>{" "}
        {chosen.kind === "pinned" ? (
          <a href={`/admin/listing/${chosen.tier.id}`}>
            {renewalTierLabel(chosen.tier)}
          </a>
        ) : (
          t("built_sites.renewal_tier_any")
        )}
      </p>
      {chosen.kind === "retired" && (
        <ErrorNote>
          {t("built_sites.renewal_tier_retired", { id: chosen.listingId })}
        </ErrorNote>
      )}
      {tiers.length === 0 ? (
        <ErrorNote>
          <Raw html={t("built_sites.no_renewal_tier")} />
        </ErrorNote>
      ) : (
        <RenewalTierForm chosen={chosen} site={site} tiers={tiers} />
      )}
    </>
  );
};

const provisionedPanel = ({ site, tiers }: TierSectionProps): JSX.Element => {
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
      <RenewalTierSection site={site} tiers={tiers} />
    </ProsePanel>
  );
};

const unprovisionedPanel = ({ site, tiers }: TierSectionProps): JSX.Element => (
  <ProsePanel
    label={t("built_sites.current_deadline")}
    value={formatDeadlineLabel(site.readOnlyFrom)}
  >
    <h3>{t("built_sites.provision_renewal_title")}</h3>
    <SiteActionForm action="provision-renewal" siteId={site.id}>
      <label for="provision_months">{t("built_sites.initial_months")}</label>
      <MonthsInput id="provision_months" />
      <TranslatedSubmitButton
        icon="hammer"
        labelKey="built_sites.provision_button"
      />
    </SiteActionForm>
    <h3>{t("built_sites.bump_deadline_title")}</h3>
    <BumpDeadlineForm site={site} />
    <h3>{t("built_sites.override_deadline_title")}</h3>
    <OverrideDeadlineForm site={site} />
    <RenewalTierSection site={site} tiers={tiers} />
  </ProsePanel>
);

export const renewalPanelFor = (
  site: BuiltSite,
  tiers: ListingWithCount[],
): JSX.Element =>
  isProvisioned(site)
    ? provisionedPanel({ site, tiers })
    : unprovisionedPanel({ site, tiers });
