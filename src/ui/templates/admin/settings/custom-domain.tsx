/**
 * Custom Domain form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { settingsFormFieldAttributes } from "#shared/settings/forms.ts";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

export const CustomDomainForm = (
  s: AdvancedSettingsPageState,
): JSX.Element | null =>
  s.bunnyCdnEnabled ? (
    <PageBlock>
      <CsrfForm
        action="/admin/settings/custom-domain"
        id="settings-custom-domain"
      >
        <div class="prose">
          <h2>{t("settings.advanced.custom_domain")}</h2>
          <p>
            <Raw html={t("settings.advanced.custom_domain_intro")} />
            {s.bunnySubdomain &&
              ` ${t("settings.advanced.custom_domain_with_subdomain")}`}
          </p>
        </div>
        <TextField
          label={t("settings.advanced.domain_label")}
          {...settingsFormFieldAttributes(
            "settings-custom-domain",
            "custom_domain",
          )}
          placeholder={t("settings.advanced.custom_domain_placeholder")}
          type="text"
          value={s.customDomain}
        />
        <SubmitButton disabled={s.paymentProviderRecoveryNeeded} icon="save">
          {t("settings.advanced.save_custom_domain")}
        </SubmitButton>
        <DomainPaymentWebhookWarning {...s} />
      </CsrfForm>

      {s.customDomain && (
        <SaveForm
          action="/admin/settings/custom-domain/validate"
          id="settings-custom-domain-validate"
          submitIcon="check"
          submitLabel={t("settings.advanced.validate_custom_domain")}
        >
          {!s.customDomainLastValidated && (
            <article>
              <aside role="alert">
                <p>{t("settings.advanced.domain_not_validated")}</p>
              </aside>
            </article>
          )}
          <article>
            <aside>
              <p>{t("settings.advanced.domain_cname_intro")}</p>
              <ol>
                <li>{t("settings.advanced.domain_cname_step_open")}</li>
                <li>
                  {t("settings.advanced.domain_cname_step_record")}
                  <ul>
                    <li>
                      <strong>{t("settings.advanced.domain_col_type")}:</strong>{" "}
                      CNAME
                    </li>
                    <li>
                      <strong>{t("settings.advanced.domain_col_name")}:</strong>{" "}
                      <code>{s.customDomain}</code>
                    </li>
                    <li>
                      <strong>
                        {t("settings.advanced.domain_col_value")}:
                      </strong>{" "}
                      <code>{s.cdnHostname}</code>
                    </li>
                    <li>
                      <strong>{t("settings.advanced.domain_col_ttl")}:</strong>{" "}
                      3600
                    </li>
                  </ul>
                </li>
                <li>{t("settings.advanced.domain_cname_step_check")}</li>
              </ol>
            </aside>
          </article>
          {s.customDomainLastValidated && (
            <p>
              <small>
                {t("settings.advanced.domain_last_validated")}{" "}
                {s.customDomainLastValidated}
              </small>
            </p>
          )}
        </SaveForm>
      )}
    </PageBlock>
  ) : null;
