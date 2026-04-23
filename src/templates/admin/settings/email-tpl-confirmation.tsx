/**
 * Confirmation Email Template form for advanced settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";

export const ConfirmationEmailTemplateForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/email-templates/confirmation"
    id="settings-email-tpl-confirmation"
  >
    <h2>Confirmation Email Template</h2>
    <p>
      Customise the registration confirmation email sent to attendees (
      <a href="/admin/guide#email-templates">template guide</a>). Uses{" "}
      <a href="https://liquidjs.com/" rel="noopener" target="_blank">
        Liquid
      </a>{" "}
      template syntax. Leave blank to use the default template.
    </p>
    <details>
      <summary>Available variables</summary>
      <table>
        <tr>
          <td>
            <code>{"{{ event_names }}"}</code>
          </td>
          <td>All event names joined with "and"</td>
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
          <td>Attendee name</td>
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
          <td>Array of event+attendee pairs</td>
        </tr>
        <tr>
          <td>
            <code>{"{{ entry.event.name }}"}</code>
          </td>
          <td>Event name (in loop)</td>
        </tr>
        <tr>
          <td>
            <code>{"{{ entry.event.is_paid }}"}</code>
          </td>
          <td>Whether event has a price</td>
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
    </details>
    <label>
      Subject
      <input
        autocomplete="off"
        name="subject"
        placeholder={DEFAULT_TEMPLATES.confirmation.subject}
        type="text"
        value={s.confirmationTemplates.subject}
      />
    </label>
    <label>
      HTML Body
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.confirmation.html}
        id="confirmation_html"
        name="html"
        placeholder="Leave blank to use default template"
        rows="8"
      >
        {s.confirmationTemplates.html}
      </textarea>
    </label>
    <a data-fill-default="confirmation_html" href="#">
      <small>Edit default template</small>
    </a>
    <label>
      Plain Text Body
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.confirmation.text}
        id="confirmation_text"
        name="text"
        placeholder="Leave blank to use default template"
        rows="6"
      >
        {s.confirmationTemplates.text}
      </textarea>
    </label>
    <a data-fill-default="confirmation_text" href="#">
      <small>Edit default template</small>
    </a>
    <br />
    <button type="submit">Save Confirmation Template</button>
  </CsrfForm>
);
