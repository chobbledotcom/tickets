/**
 * Confirmation Email Template form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { emailTemplateFields } from "#templates/components/email-template-fields.tsx";
import {
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";

/* jscpd:ignore-end */

export const ConfirmationEmailTemplateForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/email-templates/confirmation"
    description={
      <p>
        Customise the registration confirmation email sent to attendees (
        <a href="/admin/guide#email-templates">template guide</a>). Uses{" "}
        <a href="https://liquidjs.com/" rel="noopener" target="_blank">
          Liquid
        </a>{" "}
        template syntax. Leave blank to use the default template.
      </p>
    }
    id="settings-email-tpl-confirmation"
    submitLabel={t("settings.advanced.save_confirmation_template")}
    title={t("settings.advanced.confirmation_email")}
  >
    <details>
      <summary>{t("settings.advanced.available_variables")}</summary>
      <div class="table-scroll">
        <table>
          {TEMPLATE_VARIABLES.map(([code, key]) => (
            <tr>
              <td>
                <code>{code}</code>
              </td>
              <td>{t(`settings.advanced.email_variables.${key}`)}</td>
            </tr>
          ))}
        </table>
      </div>
      <p>{t("settings.advanced.email_variables.example_intro")}</p>
      <pre>{LOOP_EXAMPLE}</pre>
      <p>{t("settings.advanced.email_variables.filters_note")}</p>
      <p>{t("settings.advanced.email_variables.not_available")}</p>
    </details>
    {emailTemplateFields("confirmation")(
      s.confirmationTemplates,
      DEFAULT_TEMPLATES.confirmation,
    )}
  </SettingsSection>
);
