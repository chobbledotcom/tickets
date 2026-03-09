/**
 * Admin settings page template
 */

import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#lib/email.ts";
import { CsrfForm, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { AdminSession } from "#lib/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import {
  changePasswordFields,
  FORMATTING_HINT,
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

export type SettingsPageState = {
  stripeKeyConfigured: boolean;
  paymentProvider: string;
  squareTokenConfigured: boolean;
  squareSandbox: boolean;
  squareWebhookConfigured: boolean;
  webhookUrl: string;
  embedHosts: string;
  termsAndConditions: string;
  timezone: string;
  businessEmail: string;
  theme: string;
  showPublicSite: boolean;
  phonePrefix: string;
  headerImageUrl: string;
  storageEnabled: boolean;
  emailProvider: string;
  emailApiKeyConfigured: boolean;
  emailFromAddress: string;
  globalWebhookUrl: string;
  mailgunFrom: string;
};

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  String(
    <Layout title="Settings" theme={s.theme}>
      <AdminNav session={session} active="/admin/settings" />

        <CsrfForm action="/admin/settings/timezone" id="settings-timezone">
            <h2>Timezone</h2>
          <p>All dates and times will be interpreted and displayed in this timezone.</p>
          <label for="timezone">IANA Timezone</label>
          <select id="timezone" name="timezone" required>
            {Intl.supportedValuesOf("timeZone").map((tz: string) => (
              <option value={tz} selected={tz === s.timezone}>{tz}</option>
            ))}
          </select>
          <button type="submit">Save Timezone</button>
        </CsrfForm>

        {s.storageEnabled && (
        <div>
          {s.headerImageUrl && (
            <div>
              <img src={getImageProxyUrl(s.headerImageUrl)} alt="Header image" class="event-image-preview" />
              <CsrfForm action="/admin/settings/header-image/delete" id="settings-header-image-delete">
                <button type="submit">Remove Image</button>
              </CsrfForm>
            </div>
          )}
          <CsrfForm action="/admin/settings/header-image" enctype="multipart/form-data" id="settings-header-image">
            <h2>Header Image</h2>
            <p>An optional image displayed at the top of every page. JPEG, PNG, GIF, or WebP — max 256KB.</p>
            <label for="header_image">{s.headerImageUrl ? "Replace Image" : "Upload Image"}</label>
            <input
              type="file"
              id="header_image"
              name="header_image"
              accept="image/jpeg,image/png,image/gif,image/webp"
            />
            <button type="submit">Upload</button>
          </CsrfForm>
        </div>
        )}

        <CsrfForm action="/admin/settings/phone-prefix" id="settings-phone-prefix">
            <h2>Phone Prefix</h2>
          <p>Country calling code used when normalizing phone numbers that start with 0 (e.g. 44 for UK, 1 for US).</p>
          <label for="phone_prefix">Phone Prefix</label>
          <input
            type="number"
            id="phone_prefix"
            name="phone_prefix"
            step="1"
            min="1"
            value={s.phonePrefix}
            required
          />
          <button type="submit">Save Phone Prefix</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/business-email" id="settings-business-email">
            <h2>Business Email</h2>
          <p>This email will be included in webhook notifications and used as the reply-to address for automated emails.</p>
          <label for="business_email">Business Email</label>
          <input
            type="email"
            id="business_email"
            name="business_email"
            placeholder="contact@example.com"
            value={s.businessEmail}
            autocomplete="email"
          />
          <button type="submit">Save Business Email</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/email" id="settings-email">
            <h2>Email Notifications</h2>
          <p>Send confirmation emails to attendees and admin notifications when registrations come in.</p>
          <label for="email_provider">Email Provider</label>
          <select id="email_provider" name="email_provider">
            <option value="" selected={!s.emailProvider}>{s.mailgunFrom ? `Host Mailgun account (${s.mailgunFrom})` : s.globalWebhookUrl ? `Default webhook (${new URL(s.globalWebhookUrl).hostname})` : "None (disabled)"}</option>
            {Array.from(VALID_EMAIL_PROVIDERS).map((p) => (
              <option value={p} selected={s.emailProvider === p}>{EMAIL_PROVIDER_LABELS[p]}</option>
            ))}
          </select>
          <label for="email_api_key">API Key</label>
          <input
            type="password"
            id="email_api_key"
            name="email_api_key"
            placeholder="Enter API key"
            value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
            autocomplete="off"
          />
          <label for="email_from_address">From Address</label>
          <input
            type="email"
            id="email_from_address"
            name="email_from_address"
            placeholder={s.businessEmail || "tickets@yourdomain.com"}
            value={s.emailFromAddress}
            autocomplete="off"
          />
          <button type="submit">Save Email Settings</button>
        </CsrfForm>
        {s.emailProvider && (
        <CsrfForm action="/admin/settings/email/test" id="settings-email-test">
          <button type="submit" class="secondary">Send Test Email</button>
        </CsrfForm>
        )}

        <CsrfForm action="/admin/settings/payment-provider" id="settings-payment-provider">
            <h2>Payment Provider</h2>
          <p>Choose which payment provider to use for paid events.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="none"
                checked={!s.paymentProvider}
              />
              None (payments disabled)
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="stripe"
                checked={s.paymentProvider === "stripe"}
              />
              Stripe
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="square"
                checked={s.paymentProvider === "square"}
              />
              Square
            </label>
          </fieldset>
          <button type="submit">Save Payment Provider</button>
        </CsrfForm>

        {s.paymentProvider === "stripe" && (
        <CsrfForm action="/admin/settings/stripe" id="settings-stripe">
            <h2>Stripe Settings</h2>
          <p>
            {s.stripeKeyConfigured
              ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
              : "No Stripe key is configured. Enter your Stripe secret key to enable Stripe payments."}
          </p>
          <p><small><a href="/admin/guide#payment-setup">Where do I find this?</a></small></p>
          <Raw html={renderFields(stripeKeyFields, s.stripeKeyConfigured ? { stripe_secret_key: MASK_SENTINEL } : {})} />
          <button type="submit">Update Stripe Key</button>
          {s.stripeKeyConfigured && (
            <button type="button" id="stripe-test-btn" class="secondary">Test Connection</button>
          )}
          <div id="stripe-test-result" class="hidden"></div>
        </CsrfForm>
        )}

        {s.paymentProvider === "square" && (
        <CsrfForm action="/admin/settings/square" id="settings-square">
            <h2>Square Settings</h2>
          <p>
            {s.squareTokenConfigured
              ? "A Square access token is currently configured. Enter new credentials below to replace them."
              : "No Square access token is configured. Enter your Square credentials to enable Square payments."}
          </p>
          <p><small><a href="/admin/guide#payment-setup">Where do I find these?</a></small></p>
          <Raw html={renderFields(squareAccessTokenFields, s.squareTokenConfigured ? { square_access_token: MASK_SENTINEL } : {})} />
          <label>
            <input
              type="checkbox"
              name="square_sandbox"
              checked={s.squareSandbox}
            />
            Sandbox mode (use Square's test environment)
          </label>
          <button type="submit">Update Square Credentials</button>
        </CsrfForm>
        )}

        {s.paymentProvider === "square" && s.squareTokenConfigured && (
        <CsrfForm action="/admin/settings/square-webhook" id="settings-square-webhook">
            <h2>Square Webhook</h2>
          <p>
            <a href="/admin/guide#payment-setup">See the full setup guide</a>
          </p>
          <article>
            <aside>
              <p>To receive payment notifications, set up a webhook in your Square Developer Dashboard:</p>
              <ol>
                <li>Go to your <strong>Square Developer Dashboard</strong> and select your application</li>
                <li>Navigate to <strong>Webhooks</strong> in the left sidebar</li>
                <li>Click <strong>Add Subscription</strong></li>
                <li>Set the <strong>Notification URL</strong> to:<br /><code>{s.webhookUrl}</code></li>
                <li>Subscribe to the <strong>payment.updated</strong> event</li>
                <li>Save the subscription and copy the <strong>Signature Key</strong></li>
                <li>Paste the signature key below</li>
              </ol>
            </aside>
          </article>
          <p>
            {s.squareWebhookConfigured
              ? "A webhook signature key is currently configured. Enter a new key below to replace it."
              : "No webhook signature key is configured. Follow the steps above to set one up."}
          </p>
          <Raw html={renderFields(squareWebhookFields, s.squareWebhookConfigured ? { square_webhook_signature_key: MASK_SENTINEL } : {})} />
          <button type="submit">Update Webhook Key</button>
        </CsrfForm>
        )}

        <CsrfForm action="/admin/settings/embed-hosts" id="settings-embed-hosts">
            <h2>Only allow embedding on these hosts</h2>
          <p>Restrict which websites can embed your booking forms in an iframe. Leave blank to allow embedding from any site.</p>
          <label for="embed_hosts">Hosts (comma-separated)</label>
          <input
            type="text"
            id="embed_hosts"
            name="embed_hosts"
            placeholder="example.com, *.mysite.org"
            value={s.embedHosts}
            autocomplete="off"
          />
          <p><small>Use <code>*.example.com</code> to allow all subdomains. Direct visits to the booking page are always allowed.</small></p>
          <button type="submit">Save Embed Hosts</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/terms" id="settings-terms">
            <h2>Terms and Conditions</h2>
          <p>If set, users must agree to these terms before reserving tickets.</p>
          <label for="terms_and_conditions">Terms and Conditions</label>
          <p><small><Raw html={FORMATTING_HINT} /></small></p>
          <textarea
            id="terms_and_conditions"
            name="terms_and_conditions"
            rows="4"
            placeholder="Enter terms and conditions that attendees must agree to before registering. Leave blank to disable."
          >{s.termsAndConditions}</textarea>
          <button type="submit">Save Terms</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings" id="settings-password">
            <h2>Change Password</h2>
          <p>Changing your password will log you out of all sessions.</p>
          <Raw html={renderFields(changePasswordFields)} />
          <button type="submit">Change Password</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/show-public-site" id="settings-show-public-site">
            <h2>Show public site?</h2>
          <p>When enabled, the homepage will show a public website with navigation for Home, Events, T&amp;Cs and Contact pages.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="show_public_site"
                value="true"
                checked={s.showPublicSite === true}
              />
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="show_public_site"
                value="false"
                checked={s.showPublicSite !== true}
              />
              No
            </label>
          </fieldset>
          <button type="submit">Save</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/theme" id="settings-theme">
            <h2>Site Theme</h2>
          <p>Choose between light and dark themes for the site interface.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="theme"
                value="light"
                checked={s.theme === "light"}
              />
              Light
            </label>
            <label>
              <input
                type="radio"
                name="theme"
                value="dark"
                checked={s.theme === "dark"}
              />
              Dark
            </label>
          </fieldset>
          <button type="submit">Save Theme</button>
        </CsrfForm>

        <ResetDatabaseForm action="/admin/settings/reset-database" id="settings-reset-database" />
    </Layout>
  );
