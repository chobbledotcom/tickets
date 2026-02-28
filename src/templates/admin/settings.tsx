/**
 * Admin settings page template
 */

import { CsrfForm, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { AdminSession } from "#lib/types.ts";
import {
  changePasswordFields,
  FORMATTING_HINT,
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/** Get the success message for a form, or undefined if it doesn't match */
const successFor = (formId: string, successFormId: string, successMessage: string): string | undefined =>
  formId === successFormId ? successMessage : undefined;

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  session: AdminSession,
  stripeKeyConfigured: boolean,
  paymentProvider: string | null,
  error: string,
  successMessage: string,
  squareTokenConfigured: boolean,
  squareSandbox: boolean,
  squareWebhookConfigured: boolean,
  webhookUrl: string,
  embedHosts?: string | null,
  termsAndConditions?: string | null,
  timezone?: string,
  businessEmail?: string,
  theme?: string,
  showPublicSite?: boolean,
  phonePrefix?: string,
  headerImageUrl?: string | null,
  storageEnabled?: boolean,
  successFormId = "",
): string =>
  String(
    <Layout title="Settings" theme={theme}>
      <AdminNav session={session} active="/admin/settings" />

      {error && <div class="error">{error}</div>}

        <CsrfForm action="/admin/settings/timezone" id="settings-timezone" success={successFor("settings-timezone", successFormId, successMessage)}>
            <h2>Timezone</h2>
          <p>All dates and times will be interpreted and displayed in this timezone.</p>
          <label for="timezone">IANA Timezone</label>
          <select id="timezone" name="timezone" required>
            {Intl.supportedValuesOf("timeZone").map((tz: string) => (
              <option value={tz} selected={tz === (timezone ?? "Europe/London")}>{tz}</option>
            ))}
          </select>
          <button type="submit">Save Timezone</button>
        </CsrfForm>

        {storageEnabled && (
        <div>
          <h2>Header Image</h2>
          <p>An optional image displayed at the top of every page. JPEG, PNG, GIF, or WebP — max 256KB.</p>
          {headerImageUrl && (
            <div>
              <img src={getImageProxyUrl(headerImageUrl)} alt="Header image" class="event-image-preview" />
              <CsrfForm action="/admin/settings/header-image/delete" id="settings-header-image-delete" success={successFor("settings-header-image-delete", successFormId, successMessage)}>
                <button type="submit">Remove Image</button>
              </CsrfForm>
            </div>
          )}
          <CsrfForm action="/admin/settings/header-image" enctype="multipart/form-data" id="settings-header-image" success={successFor("settings-header-image", successFormId, successMessage)}>
            <label for="header_image">{headerImageUrl ? "Replace Image" : "Upload Image"}</label>
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

        <CsrfForm action="/admin/settings/phone-prefix" id="settings-phone-prefix" success={successFor("settings-phone-prefix", successFormId, successMessage)}>
            <h2>Phone Prefix</h2>
          <p>Country calling code used when normalizing phone numbers that start with 0 (e.g. 44 for UK, 1 for US).</p>
          <label for="phone_prefix">Phone Prefix</label>
          <input
            type="number"
            id="phone_prefix"
            name="phone_prefix"
            step="1"
            min="1"
            value={phonePrefix ?? "44"}
            required
          />
          <button type="submit">Save Phone Prefix</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/business-email" id="settings-business-email" success={successFor("settings-business-email", successFormId, successMessage)}>
            <h2>Business Email</h2>
          <p>This email will be included in webhook notifications to identify your business.</p>
          <label for="business_email">Business Email</label>
          <input
            type="email"
            id="business_email"
            name="business_email"
            placeholder="contact@example.com"
            value={businessEmail ?? ""}
            autocomplete="email"
          />
          <button type="submit">Save Business Email</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/payment-provider" id="settings-payment-provider" success={successFor("settings-payment-provider", successFormId, successMessage)}>
            <h2>Payment Provider</h2>
          <p>Choose which payment provider to use for paid events.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="none"
                checked={!paymentProvider}
              />
              None (payments disabled)
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="stripe"
                checked={paymentProvider === "stripe"}
              />
              Stripe
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="square"
                checked={paymentProvider === "square"}
              />
              Square
            </label>
          </fieldset>
          <button type="submit">Save Payment Provider</button>
        </CsrfForm>

        {paymentProvider === "stripe" && (
        <CsrfForm action="/admin/settings/stripe" id="settings-stripe" success={successFor("settings-stripe", successFormId, successMessage)}>
            <h2>Stripe Settings</h2>
          <p>
            {stripeKeyConfigured
              ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
              : "No Stripe key is configured. Enter your Stripe secret key to enable Stripe payments."}
          </p>
          <p><small><a href="/admin/guide#payment-setup">Where do I find this?</a></small></p>
          <Raw html={renderFields(stripeKeyFields)} />
          <button type="submit">Update Stripe Key</button>
          {stripeKeyConfigured && (
            <button type="button" id="stripe-test-btn" class="secondary">Test Connection</button>
          )}
          <div id="stripe-test-result" class="hidden"></div>
        </CsrfForm>
        )}

        {paymentProvider === "square" && (
        <CsrfForm action="/admin/settings/square" id="settings-square" success={successFor("settings-square", successFormId, successMessage)}>
            <h2>Square Settings</h2>
          <p>
            {squareTokenConfigured
              ? "A Square access token is currently configured. Enter new credentials below to replace them."
              : "No Square access token is configured. Enter your Square credentials to enable Square payments."}
          </p>
          <p><small><a href="/admin/guide#payment-setup">Where do I find these?</a></small></p>
          <Raw html={renderFields(squareAccessTokenFields)} />
          <label>
            <input
              type="checkbox"
              name="square_sandbox"
              checked={squareSandbox}
            />
            Sandbox mode (use Square's test environment)
          </label>
          <button type="submit">Update Square Credentials</button>
        </CsrfForm>
        )}

        {paymentProvider === "square" && squareTokenConfigured && (
        <CsrfForm action="/admin/settings/square-webhook" id="settings-square-webhook" success={successFor("settings-square-webhook", successFormId, successMessage)}>
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
                <li>Set the <strong>Notification URL</strong> to:<br /><code>{webhookUrl}</code></li>
                <li>Subscribe to the <strong>payment.updated</strong> event</li>
                <li>Save the subscription and copy the <strong>Signature Key</strong></li>
                <li>Paste the signature key below</li>
              </ol>
            </aside>
          </article>
          <p>
            {squareWebhookConfigured
              ? "A webhook signature key is currently configured. Enter a new key below to replace it."
              : "No webhook signature key is configured. Follow the steps above to set one up."}
          </p>
          <Raw html={renderFields(squareWebhookFields)} />
          <button type="submit">Update Webhook Key</button>
        </CsrfForm>
        )}

        <CsrfForm action="/admin/settings/embed-hosts" id="settings-embed-hosts" success={successFor("settings-embed-hosts", successFormId, successMessage)}>
            <h2>Only allow embedding on these hosts</h2>
          <p>Restrict which websites can embed your booking forms in an iframe. Leave blank to allow embedding from any site.</p>
          <label for="embed_hosts">Hosts (comma-separated)</label>
          <input
            type="text"
            id="embed_hosts"
            name="embed_hosts"
            placeholder="example.com, *.mysite.org"
            value={embedHosts ?? ""}
            autocomplete="off"
          />
          <p><small>Use <code>*.example.com</code> to allow all subdomains. Direct visits to the booking page are always allowed.</small></p>
          <button type="submit">Save Embed Hosts</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/terms" id="settings-terms" success={successFor("settings-terms", successFormId, successMessage)}>
            <h2>Terms and Conditions</h2>
          <p>If set, users must agree to these terms before reserving tickets.</p>
          <label for="terms_and_conditions">Terms and Conditions</label>
          <p><small><Raw html={FORMATTING_HINT} /></small></p>
          <textarea
            id="terms_and_conditions"
            name="terms_and_conditions"
            rows="4"
            placeholder="Enter terms and conditions that attendees must agree to before registering. Leave blank to disable."
          >{termsAndConditions ?? ""}</textarea>
          <button type="submit">Save Terms</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings" id="settings-password">
            <h2>Change Password</h2>
          <p>Changing your password will log you out of all sessions.</p>
          <Raw html={renderFields(changePasswordFields)} />
          <button type="submit">Change Password</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/show-public-site" id="settings-show-public-site" success={successFor("settings-show-public-site", successFormId, successMessage)}>
            <h2>Show public site?</h2>
          <p>When enabled, the homepage will show a public website with navigation for Home, Events, T&amp;Cs and Contact pages.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="show_public_site"
                value="true"
                checked={showPublicSite === true}
              />
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="show_public_site"
                value="false"
                checked={showPublicSite !== true}
              />
              No
            </label>
          </fieldset>
          <button type="submit">Save</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/theme" id="settings-theme" success={successFor("settings-theme", successFormId, successMessage)}>
            <h2>Site Theme</h2>
          <p>Choose between light and dark themes for the site interface.</p>
          <fieldset>
            <label>
              <input
                type="radio"
                name="theme"
                value="light"
                checked={(theme ?? "light") === "light"}
              />
              Light
            </label>
            <label>
              <input
                type="radio"
                name="theme"
                value="dark"
                checked={theme === "dark"}
              />
              Dark
            </label>
          </fieldset>
          <button type="submit">Save Theme</button>
        </CsrfForm>

        <CsrfForm action="/admin/settings/reset-database" id="settings-reset-database">
            <h2>Reset Database</h2>
          <article>
            <aside>
              <p><strong>Warning:</strong> This will permanently delete all events, attendees, settings, and other data. This action cannot be undone.</p>
            </aside>
          </article>
          <p>To reset the database, type the following phrase into the box below:</p>
          <p><strong>"The site will be fully reset and all data will be lost."</strong></p>
          <label for="confirm_phrase">Confirmation phrase</label>
          <input
            type="text"
            id="confirm_phrase"
            name="confirm_phrase"
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Reset Database
          </button>
        </CsrfForm>
    </Layout>
  );
