/**
 * Host Subdomain form for advanced settings
 */

import { t } from "#i18n";
import { Raw, type SafeHtml } from "#jsx/jsx-runtime";
import { CsrfForm } from "#shared/forms.tsx";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { SUBDOMAIN_INPUT_PATTERN } from "#templates/fields.ts";

const SubdomainIntroProse = (): SafeHtml => (
  <div class="prose">
    <p>
      <Raw html={t("settings.subdomain.intro")} />
    </p>
  </div>
);

const SubdomainFormContent = (s: AdvancedSettingsPageState): SafeHtml => {
  if (s.bunnySubdomain) {
    return (
      <>
        <p>
          {t("settings.subdomain.available_at")}{" "}
          <a href={`https://${s.bunnySubdomain}`}>
            <strong>{s.bunnySubdomain}</strong>
          </a>
          . {!s.customDomain && t("settings.subdomain.also_custom")}
        </p>
        <p>
          <small>{t("settings.subdomain.permanent")}</small>
        </p>
      </>
    );
  }
  if (s.subdomainPreview) {
    return (
      <>
        <SubdomainIntroProse />
        <p>
          <strong>{s.subdomainPreviewFullDomain}</strong>{" "}
          {t("settings.subdomain.is_available")}
        </p>
        <input name="subdomain" type="hidden" value={s.subdomainPreview} />
        <DomainPaymentWebhookWarning paymentProvider={s.paymentProvider} />
        <label>
          <input name="save" type="checkbox" value="1" />{" "}
          {t("settings.subdomain.confirm_registration")}
        </label>
        <footer>
          <SubmitButton icon="plus">
            {t("settings.subdomain.register_button")}
          </SubmitButton>
          <a
            class="btn secondary"
            href="/admin/settings-advanced#settings-host-subdomain"
          >
            {t("common.cancel")}
          </a>
        </footer>
      </>
    );
  }
  return (
    <>
      <SubdomainIntroProse />
      <label>
        {t("settings.subdomain.subdomain_label")}
        <input
          autocomplete="off"
          name="subdomain"
          pattern={SUBDOMAIN_INPUT_PATTERN}
          placeholder={t("settings.subdomain.subdomain_placeholder")}
          type="text"
        />
        <span class="muted">{s.bunnyDnsSubdomainSuffix}</span>
      </label>
      <DomainPaymentWebhookWarning paymentProvider={s.paymentProvider} />
      <SubmitButton icon="search">
        {t("settings.subdomain.check_button")}
      </SubmitButton>
    </>
  );
};

export const HostSubdomainForm = (
  s: AdvancedSettingsPageState,
): JSX.Element | null =>
  s.bunnyDnsEnabled ? (
    <CsrfForm
      action="/admin/settings/host-subdomain"
      id="settings-host-subdomain"
    >
      <h2>{t("settings.subdomain.heading")}</h2>
      {SubdomainFormContent(s)}
    </CsrfForm>
  ) : null;
