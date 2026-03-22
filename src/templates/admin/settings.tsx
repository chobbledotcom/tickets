/**
 * Admin settings page template
 */

import { COUNTRIES, type CountryData } from "#lib/countries.ts";
import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { CsrfForm, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { formatBytes, MAX_IMAGE_SIZE } from "#lib/limits.ts";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { AdminSession, Theme } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  changePasswordFields,
  FORMATTING_HINT,
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
} from "#templates/fields.ts";
import { t } from "#i18n";
import { Layout } from "#templates/layout.tsx";

export type SettingsPageState = {
  stripeKeyConfigured: boolean;
  stripeKeyMode: string | null;
  paymentProvider: string;
  squareTokenConfigured: boolean;
  squareSandbox: boolean;
  squareWebhookConfigured: boolean;
  webhookUrl: string;
  bookingFee: string;
  embedHosts: string;
  termsAndConditions: string;
  businessEmail: string;
  theme: Theme;
  showPublicSite: boolean;
  country: string;
  headerImageUrl: string;
  storageEnabled: boolean;
};

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  String(
    <Layout title={t("settings.title")} theme={s.theme} mainClass="stack-xl">
      <AdminNav session={session} active="/admin/settings" />

      {s.storageEnabled && (
        <div class="stack">
          {s.headerImageUrl && (
            <div>
              <img
                src={getImageProxyUrl(s.headerImageUrl)}
                alt="Header image"
                class="event-image-preview"
              />
              <CsrfForm
                action="/admin/settings/header-image/delete"
                id="settings-header-image-delete"
              >
                <button type="submit">{t("settings.remove_image")}</button>
              </CsrfForm>
            </div>
          )}
          <CsrfForm
            action="/admin/settings/header-image"
            enctype="multipart/form-data"
            id="settings-header-image"
          >
            <h2>{t("settings.header_image")}</h2>
            <p>
              {t("settings.header_image_hint", { size: formatBytes(MAX_IMAGE_SIZE) })}
            </p>
            <label>
              {s.headerImageUrl ? t("settings.replace_image") : t("settings.upload_image")}
              <input
                type="file"
                name="header_image"
                accept="image/jpeg,image/png,image/gif,image/webp"
              />
            </label>
            <button type="submit">{t("settings.upload")}</button>
          </CsrfForm>
        </div>
      )}

      <CsrfForm action="/admin/settings/country" id="settings-country">
        <h2>{t("settings.country_heading")}</h2>
        <p>{t("settings.country_hint")}</p>
        <label>
          {t("settings.country_label")}
          <select name="country" required>
            {Object.entries(COUNTRIES).map(
              ([code, data]: [string, CountryData]) => (
                <option value={code} selected={code === s.country}>
                  {data.name} ({data.currency}, +{data.phonePrefix})
                </option>
              ),
            )}
          </select>
        </label>
        <button type="submit">{t("settings.save_country")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/business-email"
        id="settings-business-email"
      >
        <h2>{t("settings.business_email")}</h2>
        <p>
          {t("settings.business_email_hint")}
        </p>
        <label>
          {t("settings.business_email")}
          <input
            type="email"
            name="business_email"
            placeholder="contact@example.com"
            value={s.businessEmail}
            autocomplete="email"
          />
        </label>
        <button type="submit">{t("settings.save_business_email")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/payment-provider"
        id="settings-payment-provider"
      >
        <h2>{t("settings.payment_provider")}</h2>
        <p>{t("settings.payment_provider_hint")}</p>
        <fieldset>
          <label>
            <input
              type="radio"
              name="payment_provider"
              value="none"
              checked={!s.paymentProvider}
            />
            {t("settings.payment_none")}
          </label>
          <label>
            <input
              type="radio"
              name="payment_provider"
              value="stripe"
              checked={s.paymentProvider === "stripe"}
            />
            {t("settings.payment_stripe")}
          </label>
          <label>
            <input
              type="radio"
              name="payment_provider"
              value="square"
              checked={s.paymentProvider === "square"}
            />
            {t("settings.payment_square")}
          </label>
        </fieldset>
        <button type="submit">{t("settings.save_payment_provider")}</button>
      </CsrfForm>

      {s.paymentProvider === "stripe" && (
        <CsrfForm action="/admin/settings/stripe" id="settings-stripe">
          <h2>{t("settings.stripe.heading")}</h2>
          <p>
            {s.stripeKeyConfigured
              ? t("settings.stripe.configured_hint")
              : t("settings.stripe.not_configured_hint")}
          </p>
          {s.stripeKeyConfigured && s.stripeKeyMode === "test" && (
            <p class="notice warning">
              {t("settings.stripe.test_mode_warning")}
            </p>
          )}
          {s.stripeKeyConfigured && s.stripeKeyMode === "live" && (
            <p class="notice">
              {t("settings.stripe.live_mode_warning")}
            </p>
          )}
          <p>
            <small>
              <a href="/admin/guide#payment-setup">{t("settings.stripe.where_to_find")}</a>
            </small>
          </p>
          <Raw
            html={renderFields(
              stripeKeyFields,
              s.stripeKeyConfigured ? { stripe_secret_key: MASK_SENTINEL } : {},
            )}
          />
          <footer>
            <button type="submit">{t("settings.stripe.update_key")}</button>
            {s.stripeKeyConfigured && (
              <button type="button" id="stripe-test-btn" class="secondary">
                {t("settings.stripe.test_connection")}
              </button>
            )}
          </footer>
          <div id="stripe-test-result" class="hidden"></div>
        </CsrfForm>
      )}

      {s.paymentProvider === "square" && (
        <CsrfForm action="/admin/settings/square" id="settings-square">
          <h2>{t("settings.square.heading")}</h2>
          <p>
            {s.squareTokenConfigured
              ? t("settings.square.configured_hint")
              : t("settings.square.not_configured_hint")}
          </p>
          <p>
            <small>
              <a href="/admin/guide#payment-setup">{t("settings.square.where_to_find")}</a>
            </small>
          </p>
          <Raw
            html={renderFields(
              squareAccessTokenFields,
              s.squareTokenConfigured
                ? { square_access_token: MASK_SENTINEL }
                : {},
            )}
          />
          <label>
            <input
              type="checkbox"
              name="square_sandbox"
              checked={s.squareSandbox}
            />
            {t("settings.square.sandbox_mode")}
          </label>
          <footer>
            <button type="submit">{t("settings.square.update_credentials")}</button>
            {s.squareTokenConfigured && (
              <button type="button" id="square-test-btn" class="secondary">
                {t("settings.square.test_connection")}
              </button>
            )}
          </footer>
          <div id="square-test-result" class="hidden"></div>
        </CsrfForm>
      )}

      {s.paymentProvider === "square" && s.squareTokenConfigured && (
        <CsrfForm
          action="/admin/settings/square-webhook"
          id="settings-square-webhook"
        >
          <h2>{t("settings.square.webhook_heading")}</h2>
          <p>
            <a href="/admin/guide#payment-setup">{t("settings.square.webhook_guide_link")}</a>
          </p>
          <article>
            <aside>
              <p>
                {t("settings.square.webhook_instructions")}
              </p>
              <ol>
                <li>
                  Go to your <strong>Square Developer Dashboard</strong> and
                  select your application
                </li>
                <li>
                  Navigate to <strong>Webhooks</strong> in the left sidebar
                </li>
                <li>
                  Click <strong>Add Subscription</strong>
                </li>
                <li>
                  Set the <strong>Notification URL</strong> to:
                  <br />
                  <code>{s.webhookUrl}</code>
                </li>
                <li>
                  Subscribe to the <strong>payment.updated</strong> event
                </li>
                <li>
                  Save the subscription and copy the{" "}
                  <strong>Signature Key</strong>
                </li>
                <li>Paste the signature key below</li>
              </ol>
            </aside>
          </article>
          <p>
            {s.squareWebhookConfigured
              ? t("settings.square.webhook_configured_hint")
              : t("settings.square.webhook_not_configured_hint")}
          </p>
          <Raw
            html={renderFields(
              squareWebhookFields,
              s.squareWebhookConfigured
                ? { square_webhook_signature_key: MASK_SENTINEL }
                : {},
            )}
          />
          <button type="submit">{t("settings.square.update_webhook_key")}</button>
        </CsrfForm>
      )}

      {s.paymentProvider && (
        <CsrfForm
          action="/admin/settings/booking-fee"
          id="settings-booking-fee"
        >
          <h2>{t("settings.booking_fee")}</h2>
          <p>
            {t("settings.booking_fee_hint")}
          </p>
          <label>
            {t("settings.booking_fee_label")}
            <input
              type="number"
              name="booking_fee"
              step="0.1"
              min="0"
              max="10"
              value={s.bookingFee}
              required
            />
          </label>
          <button type="submit">{t("settings.save_booking_fee")}</button>
        </CsrfForm>
      )}

      <CsrfForm action="/admin/settings/embed-hosts" id="settings-embed-hosts">
        <h2>{t("settings.embed_hosts")}</h2>
        <p>
          {t("settings.embed_hosts_hint")}
        </p>
        <label>
          {t("settings.embed_hosts_label")}
          <input
            type="text"
            name="embed_hosts"
            placeholder="example.com, *.mysite.org"
            value={s.embedHosts}
            autocomplete="off"
          />
        </label>
        <p>
          <small>
            {t("settings.embed_hosts_wildcard_hint")}
          </small>
        </p>
        <button type="submit">{t("settings.save_embed_hosts")}</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/terms" id="settings-terms">
        <h2>{t("settings.terms")}</h2>
        <p>{t("settings.terms_hint")}</p>
        <label>
          {t("settings.terms")}
          <p>
            <small>
              <Raw html={FORMATTING_HINT} />
            </small>
          </p>
          <textarea
            name="terms_and_conditions"
            rows="4"
            placeholder={t("settings.terms_placeholder")}
          >
            {s.termsAndConditions}
          </textarea>
        </label>
        <button type="submit">{t("settings.save_terms")}</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings" id="settings-password">
        <h2>{t("settings.change_password")}</h2>
        <p>{t("settings.change_password_hint")}</p>
        <Raw html={renderFields(changePasswordFields)} />
        <button type="submit">{t("settings.change_password")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/show-public-site"
        id="settings-show-public-site"
      >
        <h2>{t("settings.show_public_site")}</h2>
        <p>
          {t("settings.show_public_site_hint")}
        </p>
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

      <p>
        For advanced settings including public API, Apple Wallet, custom email
        templates, mail provider, timezone, custom domain, and database reset,{" "}
        <a href="/admin/settings-advanced">click here</a>.
      </p>

      <p>
        For nerdy debug info <a href="/admin/debug">click here</a>.
      </p>
    </Layout>,
  );
