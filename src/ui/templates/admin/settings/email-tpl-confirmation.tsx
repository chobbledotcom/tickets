/**
 * Confirmation Email Template form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { emailTemplateFields } from "#templates/components/email-template-fields.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";

/* jscpd:ignore-end */

// Liquid variables the confirmation template can use, shown in the reference
// table below: [what you type, the message key describing it].
const TEMPLATE_VARIABLES: [code: string, key: string][] = [
  ["{{ listing_names }}", "listing_names"],
  ["{{ ticket_url }}", "ticket_url"],
  ["{{ attendee.name }}", "attendee_name"],
  ["{{ attendee.email }}", "attendee_email"],
  ["{{ attendee.phone }}", "attendee_phone"],
  ["{{ attendee.address }}", "attendee_address"],
  ["{{ attendee.special_instructions }}", "attendee_special_instructions"],
  ["{{ entries }}", "entries"],
  ["{{ entry.listing.name }}", "entry_listing_name"],
  ["{{ entry.listing.is_paid }}", "entry_listing_is_paid"],
  ["{{ entry.attendee.quantity }}", "entry_attendee_quantity"],
  ["{{ entry.attendee.price_paid | currency }}", "entry_attendee_price_paid"],
  ["{{ entry.attendee.date }}", "entry_attendee_date"],
  ['{{ 2 | pluralize: "ticket", "tickets" }}', "pluralize"],
];

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
    </details>
    {emailTemplateFields("confirmation")(
      s.confirmationTemplates,
      DEFAULT_TEMPLATES.confirmation,
    )}
  </SettingsSection>
);
