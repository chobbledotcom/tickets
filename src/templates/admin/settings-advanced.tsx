/**
 * Admin advanced settings page template
 */

import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#lib/email.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";

export type AdvancedSettingsPageState = {
  timezone: string;
  showPublicApi: boolean;
  emailProvider: string;
  emailApiKeyConfigured: boolean;
  emailFromAddress: string;
  hostEmailLabel: string;
  businessEmail: string;
  confirmationTemplates: {
    subject: string;
    html: string;
    text: string;
  };
  adminTemplates: {
    subject: string;
    html: string;
    text: string;
  };
  bunnyCdnEnabled: boolean;
  customDomain: string;
  customDomainLastValidated: string;
  cdnHostname: string;
  appleWalletConfigured: boolean;
  appleWalletPassTypeId: string;
  appleWalletTeamId: string;
  hostAppleWalletLabel: string;
  theme: string;
};

/**
 * Admin advanced settings page
 */
export const adminAdvancedSettingsPage = (
  session: AdminSession,
  s: AdvancedSettingsPageState,
): string =>
  String(
    <Layout title="Advanced Settings" theme={s.theme}>
      <AdminNav session={session} active="/admin/settings" />
      <Breadcrumb href="/admin/settings" label="Settings" />

      <article>
        <aside>
          <p>Be careful changing settings on this page. You can break your site in ways that can be hard to diagnose. Test your booking process after making a change.</p>
        </aside>
      </article>

      <CsrfForm action="/admin/settings/show-public-api" id="settings-show-public-api">
        <h2>Enable public API?</h2>
        <p>
          Exposes a JSON API for listing events, checking availability, and creating bookings.
          See the <a href="/admin/guide#api">API guide</a> for details.
        </p>
        <fieldset>
          <label>
            <input
              type="radio"
              name="show_public_api"
              value="true"
              checked={s.showPublicApi === true}
            />
            Yes
          </label>
          <label>
            <input
              type="radio"
              name="show_public_api"
              value="false"
              checked={s.showPublicApi !== true}
            />
            No
          </label>
        </fieldset>
        <button type="submit">Save</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/apple-wallet" id="settings-apple-wallet">
        <h2>Apple Wallet</h2>
        <p>Configure Apple Wallet pass signing to show an &ldquo;Add to Apple Wallet&rdquo; button on ticket pages.{
          s.hostAppleWalletLabel && !s.appleWalletConfigured
            ? ` Currently using: ${s.hostAppleWalletLabel}. Override below or leave empty to keep using host config.`
            : s.hostAppleWalletLabel && s.appleWalletConfigured
              ? ` Overriding: ${s.hostAppleWalletLabel}.`
              : ""
        }</p>
        <label>
          Pass Type ID
          <input
            type="text"
            name="apple_wallet_pass_type_id"
            placeholder="pass.com.example.tickets"
            value={s.appleWalletPassTypeId}
            autocomplete="off"
          />
        </label>
        <label>
          Team ID
          <input
            type="text"
            name="apple_wallet_team_id"
            placeholder="ABC1234567"
            value={s.appleWalletTeamId}
            autocomplete="off"
          />
        </label>
        <label>
          Signing Certificate (PEM)
          <textarea
            name="apple_wallet_signing_cert"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
          >{s.appleWalletConfigured ? MASK_SENTINEL : ""}</textarea>
        </label>
        <label>
          Signing Private Key (PEM)
          <textarea
            name="apple_wallet_signing_key"
            rows={4}
            placeholder="-----BEGIN PRIVATE KEY-----"
          >{s.appleWalletConfigured ? MASK_SENTINEL : ""}</textarea>
        </label>
        <label>
          WWDR Certificate (PEM)
          <textarea
            name="apple_wallet_wwdr_cert"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
          >{s.appleWalletConfigured ? MASK_SENTINEL : ""}</textarea>
        </label>
        <button type="submit">Save Apple Wallet Settings</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/email-templates/confirmation" id="settings-email-tpl-confirmation">
        <h2>Confirmation Email Template</h2>
        <p>Customise the registration confirmation email sent to attendees. Uses <a href="https://liquidjs.com/" target="_blank" rel="noopener">Liquid</a> template syntax. Leave blank to use the default template.</p>
        <details>
          <summary>Available variables</summary>
          <table>
            <tr><td><code>{`{{ event_names }}`}</code></td><td>All event names joined with "and"</td></tr>
            <tr><td><code>{`{{ ticket_url }}`}</code></td><td>Link to view tickets</td></tr>
            <tr><td><code>{`{{ attendee.name }}`}</code></td><td>Attendee name</td></tr>
            <tr><td><code>{`{{ attendee.email }}`}</code></td><td>Attendee email</td></tr>
            <tr><td><code>{`{{ attendee.phone }}`}</code></td><td>Attendee phone</td></tr>
            <tr><td><code>{`{{ attendee.address }}`}</code></td><td>Attendee address</td></tr>
            <tr><td><code>{`{{ attendee.special_instructions }}`}</code></td><td>Special instructions</td></tr>
            <tr><td><code>{`{{ entries }}`}</code></td><td>Array of event+attendee pairs</td></tr>
            <tr><td><code>{`{{ entry.event.name }}`}</code></td><td>Event name (in loop)</td></tr>
            <tr><td><code>{`{{ entry.event.is_paid }}`}</code></td><td>Whether event has a price</td></tr>
            <tr><td><code>{`{{ entry.attendee.quantity }}`}</code></td><td>Ticket quantity</td></tr>
            <tr><td><code>{`{{ entry.attendee.price_paid | currency }}`}</code></td><td>Price formatted as currency</td></tr>
            <tr><td><code>{`{{ entry.attendee.date }}`}</code></td><td>Selected date (if any)</td></tr>
            <tr><td><code>{`{{ 2 | pluralize: "ticket", "tickets" }}`}</code></td><td>Pluralize based on count</td></tr>
          </table>
        </details>
        <label>Subject
          <input
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.confirmation.subject}
            value={s.confirmationTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>HTML Body
          <textarea
            id="confirmation_html"
            name="html"
            rows="8"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.html}
          >{s.confirmationTemplates.html}</textarea>
        </label>
        <a href="#" data-fill-default="confirmation_html"><small>Edit default template</small></a>
        <label>Plain Text Body
          <textarea
            id="confirmation_text"
            name="text"
            rows="6"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.text}
          >{s.confirmationTemplates.text}</textarea>
        </label>
        <a href="#" data-fill-default="confirmation_text"><small>Edit default template</small></a>
        <br />
        <button type="submit">Save Confirmation Template</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/email-templates/admin" id="settings-email-tpl-admin">
        <h2>Admin Notification Email Template</h2>
        <p>Customise the notification email sent to the business email when a registration comes in. Leave blank to use the default template.</p>
        <label>Subject
          <input
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.admin.subject}
            value={s.adminTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>HTML Body
          <textarea
            id="admin_html"
            name="html"
            rows="8"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.admin.html}
          >{s.adminTemplates.html}</textarea>
        </label>
        <a href="#" data-fill-default="admin_html"><small>Edit default template</small></a>
        <label>Plain Text Body
          <textarea
            id="admin_text"
            name="text"
            rows="6"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.admin.text}
          >{s.adminTemplates.text}</textarea>
        </label>
        <a href="#" data-fill-default="admin_text"><small>Edit default template</small></a>
        <br />
        <button type="submit">Save Admin Notification Template</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/email" id="settings-email">
        <h2>Email Notifications</h2>
        <p>Send confirmation emails to attendees and admin notifications when registrations come in.</p>
        <label>Email Provider
          <select name="email_provider">
            <option value="" selected={!s.emailProvider}>{s.hostEmailLabel || "None (disabled)"}</option>
            {Array.from(VALID_EMAIL_PROVIDERS).map((p) => (
              <option value={p} selected={s.emailProvider === p}>{EMAIL_PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>API Key
          <input
            type="password"
            name="email_api_key"
            placeholder="Enter API key"
            value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
            autocomplete="off"
          />
        </label>
        <label>From Address
          <input
            type="email"
            name="email_from_address"
            placeholder={s.businessEmail || "tickets@yourdomain.com"}
            value={s.emailFromAddress}
            autocomplete="off"
          />
        </label>
        <button type="submit">Save Email Settings</button>
      </CsrfForm>
      {s.emailProvider && (
      <CsrfForm action="/admin/settings/email/test" id="settings-email-test">
        <button type="submit" class="secondary">Send Test Email</button>
      </CsrfForm>
      )}

      <CsrfForm action="/admin/settings/timezone" id="settings-timezone">
        <h2>Timezone</h2>
        <p>All dates and times will be interpreted and displayed in this timezone.</p>
        <label>IANA Timezone
          <select name="timezone" required>
            {Intl.supportedValuesOf("timeZone").map((tz: string) => (
              <option value={tz} selected={tz === s.timezone}>{tz}</option>
            ))}
          </select>
        </label>
        <button type="submit">Save Timezone</button>
      </CsrfForm>

      {s.bunnyCdnEnabled && (
      <div>
        <CsrfForm action="/admin/settings/custom-domain" id="settings-custom-domain">
          <h2>Custom Domain</h2>
          <p>Set a custom domain for your booking site.</p>
          <label>Domain
            <input
              type="text"
              name="custom_domain"
              placeholder="tickets.yourdomain.com"
              value={s.customDomain}
              autocomplete="off"
            />
          </label>
          <button type="submit">Save Custom Domain</button>
        </CsrfForm>

        {s.customDomain && (
        <CsrfForm action="/admin/settings/custom-domain/validate" id="settings-custom-domain-validate">
          {!s.customDomainLastValidated && (
          <article>
            <aside role="alert">
              <p><strong>Your custom domain is not yet validated.</strong> It will not work until validation is complete.</p>
            </aside>
          </article>
          )}
          <article>
            <aside>
              <p>To use your custom domain, create a <strong>CNAME</strong> record:</p>
              <table>
                <thead>
                  <tr><th>Type</th><th>Name</th><th>Value</th></tr>
                </thead>
                <tbody>
                  <tr><td>CNAME</td><td><code>{s.customDomain}</code></td><td><code>{s.cdnHostname}</code></td></tr>
                </tbody>
              </table>
              <p>Once the DNS record is in place, click the button below to validate and enable SSL.</p>
            </aside>
          </article>
          {s.customDomainLastValidated && (
            <p><small>Last validated: {s.customDomainLastValidated}</small></p>
          )}
          <button type="submit">Validate Custom Domain</button>
        </CsrfForm>
        )}
      </div>
      )}

      <ResetDatabaseForm action="/admin/settings/reset-database" id="settings-reset-database" />
    </Layout>
  );
