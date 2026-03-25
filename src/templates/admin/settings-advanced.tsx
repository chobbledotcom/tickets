/**
 * Admin advanced settings page template
 */

import type { SafeHtml } from "#jsx/jsx-runtime";
import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#lib/email.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession, Theme } from "#lib/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import { Layout } from "#templates/layout.tsx";

export type AdvancedSettingsPageState = {
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
  bunnyDnsEnabled: boolean;
  bunnySubdomain: string;
  bunnyDnsSubdomainSuffix: string;
  subdomainPreview: string;
  subdomainPreviewFullDomain: string;
  customDomain: string;
  customDomainLastValidated: string;
  cdnHostname: string;
  appleWalletConfigured: boolean;
  appleWalletPassTypeId: string;
  appleWalletTeamId: string;
  hostAppleWalletLabel: string;
  googleWalletConfigured: boolean;
  googleWalletIssuerId: string;
  googleWalletServiceAccountEmail: string;
  hostGoogleWalletLabel: string;
  theme: Theme;
};

const SubdomainIntroProse = (): SafeHtml => (
  <p>
    You can choose a prettier domain name for your tickets site. Enter a
    subdomain into the box below to preview the full URL &mdash; you can change
    your mind before saving, but once set this cannot be changed.
  </p>
);

const SubdomainFormContent = (s: AdvancedSettingsPageState): SafeHtml => {
  if (s.bunnySubdomain) {
    return (
      <>
        <p>
          Your site is available at{" "}
          <a href={`https://${s.bunnySubdomain}`}>
            <strong>{s.bunnySubdomain}</strong>
          </a>
          .{" "}
          {s.customDomain && s.customDomainLastValidated
            ? `Visitors will be redirected to your custom domain (${s.customDomain}).`
            : "You can also set a custom domain below."}
        </p>
        <p>
          <small>This subdomain is permanent and cannot be changed.</small>
        </p>
      </>
    );
  }
  if (s.subdomainPreview) {
    return (
      <>
        <SubdomainIntroProse />
        <p>
          <strong>{s.subdomainPreviewFullDomain}</strong> is available.
        </p>
        <input type="hidden" name="subdomain" value={s.subdomainPreview} />
        <label>
          <input type="checkbox" name="save" value="1" /> Confirm registration
          (cannot be undone)
        </label>
        <footer>
          <button type="submit">Register Subdomain</button>
          <a
            href="/admin/settings/advanced#settings-host-subdomain"
            class="secondary"
          >
            Cancel
          </a>
        </footer>
      </>
    );
  }
  return (
    <>
      <SubdomainIntroProse />
      <label>
        Subdomain
        <input
          type="text"
          name="subdomain"
          placeholder="myevent"
          autocomplete="off"
          pattern="[a-z0-9]([a-z0-9-]{'{'}0,61{'}'}[a-z0-9])?"
        />
        <span class="muted">{s.bunnyDnsSubdomainSuffix}</span>
      </label>
      <button type="submit">
        Check Availability &amp; Preview Complete Domain
      </button>
    </>
  );
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

      <article>
        <aside>
          <p>
            Be careful changing settings on this page. You can break your site
            in ways that can be hard to diagnose. Test your booking process
            after making a change.
          </p>
        </aside>
      </article>

      <CsrfForm
        action="/admin/settings/show-public-api"
        id="settings-show-public-api"
      >
        <h2>Enable public API?</h2>
        <p>
          Exposes a JSON API for listing events, checking availability, and
          creating bookings. See the <a href="/admin/guide#api">API guide</a>{" "}
          for details.
        </p>
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
        <button type="submit">Save</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/apple-wallet"
        id="settings-apple-wallet"
      >
        <h2>Apple Wallet</h2>
        <p>
          Configure Apple Wallet pass signing to show an &ldquo;Add to Apple
          Wallet&rdquo; button on ticket pages.
          {s.hostAppleWalletLabel && !s.appleWalletConfigured
            ? ` Currently using: ${s.hostAppleWalletLabel}. Override below or leave empty to keep using host config.`
            : s.hostAppleWalletLabel && s.appleWalletConfigured
              ? ` Overriding: ${s.hostAppleWalletLabel}.`
              : ""}
        </p>
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
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <label>
          Signing Private Key (PEM)
          <textarea
            name="apple_wallet_signing_key"
            rows={4}
            placeholder="-----BEGIN PRIVATE KEY-----"
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <label>
          WWDR Certificate (PEM)
          <textarea
            name="apple_wallet_wwdr_cert"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <button type="submit">Save Apple Wallet Settings</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/google-wallet"
        id="settings-google-wallet"
      >
        <h2>Google Wallet</h2>
        <p>
          Configure Google Wallet to show an &ldquo;Add to Google Wallet&rdquo;
          button on ticket pages. Requires a Google Cloud service account with
          the Google Wallet API enabled.
          {s.hostGoogleWalletLabel && !s.googleWalletConfigured
            ? ` Currently using: ${s.hostGoogleWalletLabel}. Override below or leave empty to keep using host config.`
            : s.hostGoogleWalletLabel && s.googleWalletConfigured
              ? ` Overriding: ${s.hostGoogleWalletLabel}.`
              : ""}
        </p>
        <label>
          Issuer ID
          <input
            type="text"
            name="google_wallet_issuer_id"
            placeholder="3388000000012345678"
            value={s.googleWalletIssuerId}
            autocomplete="off"
          />
        </label>
        <label>
          Service Account Email
          <input
            type="email"
            name="google_wallet_service_account_email"
            placeholder="wallet@project.iam.gserviceaccount.com"
            value={s.googleWalletServiceAccountEmail}
            autocomplete="off"
          />
        </label>
        <label>
          Service Account Private Key (PEM)
          <textarea
            name="google_wallet_service_account_key"
            rows={4}
            placeholder="-----BEGIN PRIVATE KEY-----"
          >
            {s.googleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <button type="submit">Save Google Wallet Settings</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/email-templates/confirmation"
        id="settings-email-tpl-confirmation"
      >
        <h2>Confirmation Email Template</h2>
        <p>
          Customise the registration confirmation email sent to attendees. Uses{" "}
          <a href="https://liquidjs.com/" target="_blank" rel="noopener">
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
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.confirmation.subject}
            value={s.confirmationTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>
          HTML Body
          <textarea
            id="confirmation_html"
            name="html"
            rows="8"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.html}
          >
            {s.confirmationTemplates.html}
          </textarea>
        </label>
        <a href="#" data-fill-default="confirmation_html">
          <small>Edit default template</small>
        </a>
        <label>
          Plain Text Body
          <textarea
            id="confirmation_text"
            name="text"
            rows="6"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.text}
          >
            {s.confirmationTemplates.text}
          </textarea>
        </label>
        <a href="#" data-fill-default="confirmation_text">
          <small>Edit default template</small>
        </a>
        <br />
        <button type="submit">Save Confirmation Template</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/email-templates/admin"
        id="settings-email-tpl-admin"
      >
        <h2>Admin Notification Email Template</h2>
        <p>
          Customise the notification email sent to the business email when a
          registration comes in. Leave blank to use the default template.
        </p>
        <label>
          Subject
          <input
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.admin.subject}
            value={s.adminTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>
          HTML Body
          <textarea
            id="admin_html"
            name="html"
            rows="8"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.admin.html}
          >
            {s.adminTemplates.html}
          </textarea>
        </label>
        <a href="#" data-fill-default="admin_html">
          <small>Edit default template</small>
        </a>
        <label>
          Plain Text Body
          <textarea
            id="admin_text"
            name="text"
            rows="6"
            placeholder="Leave blank to use default template"
            data-default-tpl={DEFAULT_TEMPLATES.admin.text}
          >
            {s.adminTemplates.text}
          </textarea>
        </label>
        <a href="#" data-fill-default="admin_text">
          <small>Edit default template</small>
        </a>
        <br />
        <button type="submit">Save Admin Notification Template</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/email" id="settings-email">
        <h2>Email Notifications</h2>
        <p>
          Send confirmation emails to attendees and admin notifications when
          registrations come in.
        </p>
        <label>
          Email Provider
          <select name="email_provider">
            <option value="" selected={!s.emailProvider}>
              {s.hostEmailLabel || "None (disabled)"}
            </option>
            {Array.from(VALID_EMAIL_PROVIDERS).map((p) => (
              <option value={p} selected={s.emailProvider === p}>
                {EMAIL_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          API Key
          <input
            type="password"
            name="email_api_key"
            placeholder="Enter API key"
            value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
            autocomplete="off"
          />
        </label>
        <label>
          From Address
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
          <button type="submit" class="secondary">
            Send Test Email
          </button>
        </CsrfForm>
      )}

      {s.bunnyDnsEnabled && (
        <CsrfForm
          action="/admin/settings/host-subdomain"
          id="settings-host-subdomain"
        >
          <h2>Host Subdomain</h2>
          {SubdomainFormContent(s)}
        </CsrfForm>
      )}

      {s.bunnyCdnEnabled && (
        <div class="stack stack-sm">
          <CsrfForm
            action="/admin/settings/custom-domain"
            id="settings-custom-domain"
          >
            <h2>Custom Domain</h2>
            <p>
              Set a custom domain for your tickets site.
              {s.bunnySubdomain &&
                " Your host subdomain can be active at the same time as a custom domain."}
            </p>
            <label>
              Domain
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
            <CsrfForm
              action="/admin/settings/custom-domain/validate"
              id="settings-custom-domain-validate"
            >
              {!s.customDomainLastValidated && (
                <article>
                  <aside role="alert">
                    <p>
                      <strong>Your custom domain is not yet validated.</strong>{" "}
                      It will not work until validation is complete.
                    </p>
                  </aside>
                </article>
              )}
              <article>
                <aside>
                  <p>
                    To use your custom domain, create a <strong>CNAME</strong>{" "}
                    record:
                  </p>
                  <ul>
                    <li>
                      <strong>Type:</strong> CNAME
                    </li>
                    <li>
                      <strong>Name:</strong> <code>{s.customDomain}</code>
                    </li>
                    <li>
                      <strong>Value:</strong> <code>{s.cdnHostname}</code>
                    </li>
                    <li>
                      <strong>TTL:</strong> 3600
                    </li>
                  </ul>
                  <p>
                    Once the DNS record is in place, click the button below to
                    validate and enable SSL.
                  </p>
                </aside>
              </article>
              {s.customDomainLastValidated && (
                <p>
                  <small>Last validated: {s.customDomainLastValidated}</small>
                </p>
              )}
              <button type="submit">Validate Custom Domain</button>
            </CsrfForm>
          )}
        </div>
      )}

      <ResetDatabaseForm
        action="/admin/settings/reset-database"
        id="settings-reset-database"
      />
    </Layout>,
  );
