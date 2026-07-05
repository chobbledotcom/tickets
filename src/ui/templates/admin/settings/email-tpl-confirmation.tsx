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
          <tr>
            <td>
              <code>{"{{ listing_names }}"}</code>
            </td>
            <td>All listing names joined with "and"</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ ticket_url }}"}</code>
            </td>
            <td>Link to view tickets</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ attendee.name }}"}</code>
            </td>
            <td>{t("admin.attendees.delete_label")}</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ attendee.email }}"}</code>
            </td>
            <td>Attendee email</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ attendee.phone }}"}</code>
            </td>
            <td>Attendee phone</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ attendee.address }}"}</code>
            </td>
            <td>Attendee address</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ attendee.special_instructions }}"}</code>
            </td>
            <td>Special instructions</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entries }}"}</code>
            </td>
            <td>Array of listing+attendee pairs</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entry.listing.name }}"}</code>
            </td>
            <td>Listing name (in loop)</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entry.listing.is_paid }}"}</code>
            </td>
            <td>Whether listing has a price</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entry.attendee.quantity }}"}</code>
            </td>
            <td>Ticket quantity</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entry.attendee.price_paid | currency }}"}</code>
            </td>
            <td>Price formatted as currency</td>
          </tr>
          <tr>
            <td>
              <code>{"{{ entry.attendee.date }}"}</code>
            </td>
            <td>Selected date (if any)</td>
          </tr>
          <tr>
            <td>
              <code>{`{{ 2 | pluralize: "ticket", "tickets" }}`}</code>
            </td>
            <td>Pluralize based on count</td>
          </tr>
        </table>
      </div>
    </details>
    {emailTemplateFields("confirmation")(
      s.confirmationTemplates,
      DEFAULT_TEMPLATES.confirmation,
    )}
  </SettingsSection>
);
