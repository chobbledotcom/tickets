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
// table below: [what you type, what it renders].
const TEMPLATE_VARIABLES: [code: string, meaning: string][] = [
  ["{{ listing_names }}", 'All listing names joined with "and"'],
  ["{{ ticket_url }}", "Link to view tickets"],
  ["{{ attendee.name }}", t("admin.attendees.delete_label")],
  ["{{ attendee.email }}", "Attendee email"],
  ["{{ attendee.phone }}", "Attendee phone"],
  ["{{ attendee.address }}", "Attendee address"],
  ["{{ attendee.special_instructions }}", "Special instructions"],
  ["{{ entries }}", "Array of listing+attendee pairs"],
  ["{{ entry.listing.name }}", "Listing name (in loop)"],
  ["{{ entry.listing.is_paid }}", "Whether listing has a price"],
  ["{{ entry.attendee.quantity }}", "Ticket quantity"],
  ["{{ entry.attendee.price_paid | currency }}", "Price formatted as currency"],
  ["{{ entry.attendee.date }}", "Selected date (if any)"],
  ['{{ 2 | pluralize: "ticket", "tickets" }}', "Pluralize based on count"],
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
          {TEMPLATE_VARIABLES.map(([code, meaning]) => (
            <tr>
              <td>
                <code>{code}</code>
              </td>
              <td>{meaning}</td>
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
