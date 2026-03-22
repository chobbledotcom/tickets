/**
 * Admin advanced settings page template
 */

import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#lib/email.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession, Theme } from "#lib/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import { t } from "#i18n";
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

/**
 * Admin advanced settings page
 */
export const adminAdvancedSettingsPage = (
  session: AdminSession,
  s: AdvancedSettingsPageState,
): string =>
  String(
    <Layout title={t("settings.advanced.title")} theme={s.theme} mainClass="stack-xl">
      <AdminNav session={session} active="/admin/settings" />
      <Breadcrumb href="/admin/settings" label={t("settings.title")} />

      <article>
        <aside>
          <p>
            {t("settings.advanced.warning")}
          </p>
        </aside>
      </article>

      <CsrfForm
        action="/admin/settings/show-public-api"
        id="settings-show-public-api"
      >
        <h2>{t("settings.advanced.public_api")}</h2>
        <p>
          {t("settings.advanced.public_api_hint")}
        </p>
        <fieldset>
          <label>
            <input
              type="radio"
              name="show_public_api"
              value="true"
              checked={s.showPublicApi === true}
            />
            {t("common.yes")}
          </label>
          <label>
            <input
              type="radio"
              name="show_public_api"
              value="false"
              checked={s.showPublicApi !== true}
            />
            {t("common.no")}
          </label>
        </fieldset>
        <button type="submit">{t("common.save")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/apple-wallet"
        id="settings-apple-wallet"
      >
        <h2>{t("settings.advanced.apple_wallet")}</h2>
        <p>
          {t("settings.advanced.apple_wallet_hint")}
          {s.hostAppleWalletLabel && !s.appleWalletConfigured
            ? ` Currently using: ${s.hostAppleWalletLabel}. Override below or leave empty to keep using host config.`
            : s.hostAppleWalletLabel && s.appleWalletConfigured
              ? ` Overriding: ${s.hostAppleWalletLabel}.`
              : ""}
        </p>
        <label>
          {t("settings.advanced.apple_pass_type_id")}
          <input
            type="text"
            name="apple_wallet_pass_type_id"
            placeholder="pass.com.example.tickets"
            value={s.appleWalletPassTypeId}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.apple_team_id")}
          <input
            type="text"
            name="apple_wallet_team_id"
            placeholder="ABC1234567"
            value={s.appleWalletTeamId}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.apple_signing_cert")}
          <textarea
            name="apple_wallet_signing_cert"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <label>
          {t("settings.advanced.apple_signing_key")}
          <textarea
            name="apple_wallet_signing_key"
            rows={4}
            placeholder="-----BEGIN PRIVATE KEY-----"
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <label>
          {t("settings.advanced.apple_wwdr_cert")}
          <textarea
            name="apple_wallet_wwdr_cert"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
          >
            {s.appleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <button type="submit">{t("settings.advanced.save_apple_wallet")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/google-wallet"
        id="settings-google-wallet"
      >
        <h2>{t("settings.advanced.google_wallet")}</h2>
        <p>
          {t("settings.advanced.google_wallet_hint")}
          {s.hostGoogleWalletLabel && !s.googleWalletConfigured
            ? ` Currently using: ${s.hostGoogleWalletLabel}. Override below or leave empty to keep using host config.`
            : s.hostGoogleWalletLabel && s.googleWalletConfigured
              ? ` Overriding: ${s.hostGoogleWalletLabel}.`
              : ""}
        </p>
        <label>
          {t("settings.advanced.google_issuer_id")}
          <input
            type="text"
            name="google_wallet_issuer_id"
            placeholder="3388000000012345678"
            value={s.googleWalletIssuerId}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.google_service_email")}
          <input
            type="email"
            name="google_wallet_service_account_email"
            placeholder="wallet@project.iam.gserviceaccount.com"
            value={s.googleWalletServiceAccountEmail}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.google_service_key")}
          <textarea
            name="google_wallet_service_account_key"
            rows={4}
            placeholder="-----BEGIN PRIVATE KEY-----"
          >
            {s.googleWalletConfigured ? MASK_SENTINEL : ""}
          </textarea>
        </label>
        <button type="submit">{t("settings.advanced.save_google_wallet")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/email-templates/confirmation"
        id="settings-email-tpl-confirmation"
      >
        <h2>{t("settings.advanced.confirmation_email")}</h2>
        <p>
          {t("settings.advanced.confirmation_email_hint")}
        </p>
        <details>
          <summary>{t("settings.advanced.available_variables")}</summary>
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
          {t("settings.advanced.subject")}
          <input
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.confirmation.subject}
            value={s.confirmationTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.html_body")}
          <textarea
            id="confirmation_html"
            name="html"
            rows="8"
            placeholder={t("settings.advanced.leave_blank_default")}
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.html}
          >
            {s.confirmationTemplates.html}
          </textarea>
        </label>
        <a href="#" data-fill-default="confirmation_html">
          <small>{t("settings.advanced.edit_default_template")}</small>
        </a>
        <label>
          {t("settings.advanced.plain_text_body")}
          <textarea
            id="confirmation_text"
            name="text"
            rows="6"
            placeholder={t("settings.advanced.leave_blank_default")}
            data-default-tpl={DEFAULT_TEMPLATES.confirmation.text}
          >
            {s.confirmationTemplates.text}
          </textarea>
        </label>
        <a href="#" data-fill-default="confirmation_text">
          <small>{t("settings.advanced.edit_default_template")}</small>
        </a>
        <br />
        <button type="submit">{t("settings.advanced.save_confirmation_template")}</button>
      </CsrfForm>

      <CsrfForm
        action="/admin/settings/email-templates/admin"
        id="settings-email-tpl-admin"
      >
        <h2>{t("settings.advanced.admin_notification_email")}</h2>
        <p>
          {t("settings.advanced.admin_notification_email_hint")}
        </p>
        <label>
          {t("settings.advanced.subject")}
          <input
            type="text"
            name="subject"
            placeholder={DEFAULT_TEMPLATES.admin.subject}
            value={s.adminTemplates.subject}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.html_body")}
          <textarea
            id="admin_html"
            name="html"
            rows="8"
            placeholder={t("settings.advanced.leave_blank_default")}
            data-default-tpl={DEFAULT_TEMPLATES.admin.html}
          >
            {s.adminTemplates.html}
          </textarea>
        </label>
        <a href="#" data-fill-default="admin_html">
          <small>{t("settings.advanced.edit_default_template")}</small>
        </a>
        <label>
          {t("settings.advanced.plain_text_body")}
          <textarea
            id="admin_text"
            name="text"
            rows="6"
            placeholder={t("settings.advanced.leave_blank_default")}
            data-default-tpl={DEFAULT_TEMPLATES.admin.text}
          >
            {s.adminTemplates.text}
          </textarea>
        </label>
        <a href="#" data-fill-default="admin_text">
          <small>{t("settings.advanced.edit_default_template")}</small>
        </a>
        <br />
        <button type="submit">{t("settings.advanced.save_admin_notification_template")}</button>
      </CsrfForm>

      <CsrfForm action="/admin/settings/email" id="settings-email">
        <h2>{t("settings.advanced.email_notifications")}</h2>
        <p>
          {t("settings.advanced.email_notifications_hint")}
        </p>
        <label>
          {t("settings.advanced.email_provider")}
          <select name="email_provider">
            <option value="" selected={!s.emailProvider}>
              {s.hostEmailLabel || t("settings.advanced.email_none")}
            </option>
            {Array.from(VALID_EMAIL_PROVIDERS).map((p) => (
              <option value={p} selected={s.emailProvider === p}>
                {EMAIL_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("settings.advanced.api_key")}
          <input
            type="password"
            name="email_api_key"
            placeholder={t("settings.advanced.api_key_placeholder")}
            value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
            autocomplete="off"
          />
        </label>
        <label>
          {t("settings.advanced.from_address")}
          <input
            type="email"
            name="email_from_address"
            placeholder={s.businessEmail || "tickets@yourdomain.com"}
            value={s.emailFromAddress}
            autocomplete="off"
          />
        </label>
        <button type="submit">{t("settings.advanced.save_email_settings")}</button>
      </CsrfForm>
      {s.emailProvider && (
        <CsrfForm action="/admin/settings/email/test" id="settings-email-test">
          <button type="submit" class="secondary">
            {t("settings.advanced.send_test_email")}
          </button>
        </CsrfForm>
      )}

      {s.bunnyCdnEnabled && (
        <div>
          <CsrfForm
            action="/admin/settings/custom-domain"
            id="settings-custom-domain"
          >
            <h2>{t("settings.advanced.custom_domain")}</h2>
            <p>{t("settings.advanced.custom_domain_hint")}</p>
            <label>
              {t("settings.advanced.domain_label")}
              <input
                type="text"
                name="custom_domain"
                placeholder="tickets.yourdomain.com"
                value={s.customDomain}
                autocomplete="off"
              />
            </label>
            <button type="submit">{t("settings.advanced.save_custom_domain")}</button>
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
                      <strong>{t("settings.advanced.domain_not_validated")}</strong>
                    </p>
                  </aside>
                </article>
              )}
              <article>
                <aside>
                  <p>
                    {t("settings.advanced.domain_cname_instructions")}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>{t("settings.advanced.domain_col_type")}</th>
                        <th>{t("settings.advanced.domain_col_name")}</th>
                        <th>{t("settings.advanced.domain_col_value")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>CNAME</td>
                        <td>
                          <code>{s.customDomain}</code>
                        </td>
                        <td>
                          <code>{s.cdnHostname}</code>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p>
                    {t("settings.advanced.domain_dns_hint")}
                  </p>
                </aside>
              </article>
              {s.customDomainLastValidated && (
                <p>
                  <small>{t("settings.advanced.domain_last_validated")} {s.customDomainLastValidated}</small>
                </p>
              )}
              <button type="submit">{t("settings.advanced.validate_custom_domain")}</button>
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
