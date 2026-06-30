/**
 * Setup page templates - initial configuration
 */

import { t } from "#i18n";
import { COUNTRIES, DEFAULT_COUNTRY } from "#shared/countries.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ActionButton } from "#templates/components/actions.tsx";
import { getSetupFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Data Controller Agreement - displayed during setup
 * Users must accept these terms to complete setup
 */
const DataControllerAgreement = (): JSX.Element => (
  <fieldset class="agreement">
    <legend>{t("setup.agreement.title")}</legend>
    <p>{t("setup.agreement.intro")}</p>
    <ol>
      <li>
        <strong>{t("setup.agreement.controller_title")}</strong> - You decide
        what data to collect and are responsible for your own GDPR/data
        protection compliance
      </li>
      <li>
        <strong>{t("setup.agreement.processor_title")}</strong> - We store your
        encrypted data but cannot access attendee information without your admin
        password
      </li>
      <li>
        <strong>{t("setup.agreement.encrypted_title")}</strong> - Attendee
        names, emails, and payment references are encrypted at rest. Only you
        can decrypt them by logging in
      </li>
      <li>
        <strong>{t("setup.agreement.responsibilities_title")}</strong> - You are
        responsible for providing a privacy policy, having lawful basis for
        collecting data, responding to data subject requests, and compliance
        with your local data protection laws
      </li>
      <li>
        <strong>{t("setup.agreement.breach_title")}</strong> - We will notify
        you promptly if we detect a security incident affecting your data
      </li>
      <li>
        <strong>{t("setup.agreement.deletion_title")}</strong> - Your data is
        deleted when you delete your listings or close your account
      </li>
    </ol>
    <p class="password-warning">
      If you lose your password you will be <u>permanently</u> unable to view
      attendee lists. Do not lose your password.
    </p>
    <div class="field">
      <label>
        <input name="accept_agreement" required type="checkbox" value="yes" />
        {t("setup.agreement.accept")}
      </label>
    </div>
  </fieldset>
);

/**
 * Initial setup page
 */
export const setupPage = (error?: string): string =>
  String(
    <Layout title={t("setup.title")}>
      <CsrfForm action="/setup/">
        <div class="prose">
          <h1>{t("setup.heading")}</h1>
          <p>{t("setup.welcome")}</p>
        </div>
        <Flash error={error} />
        <Raw html={renderFields(getSetupFields())} />
        <div class="field">
          <label>
            {t("setup.country_label")}
            <select name="country" required>
              {Object.entries(COUNTRIES).map(([code, data]) => (
                <option selected={code === DEFAULT_COUNTRY} value={code}>
                  {data.name} ({data.currency})
                </option>
              ))}
            </select>
          </label>
          <p class="hint">{t("setup.country_hint")}</p>
        </div>
        <DataControllerAgreement />
        <button type="submit">{t("setup.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  String(
    <Layout title={t("setup.complete.title")}>
      <h1>{t("setup.complete.heading")}</h1>
      <div class="success" role="alert">
        <p>{t("setup.complete.message")}</p>
      </div>
      <p class="actions">
        <ActionButton href="/admin/login" icon="log-in">
          {t("setup.complete.login_link")}
        </ActionButton>
      </p>
    </Layout>,
  );
