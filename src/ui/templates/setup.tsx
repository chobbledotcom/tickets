/**
 * Setup page templates - initial configuration
 */

import { t } from "#i18n";
import { COUNTRIES, DEFAULT_COUNTRY } from "#shared/countries.ts";
import { renderFields } from "#shared/forms.tsx";
import { IntroFormPage } from "#templates/components/intro-form-page.tsx";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { getSetupFields } from "#templates/fields.ts";

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
  IntroFormPage({
    action: "/setup/",
    children: (
      <>
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
      </>
    ),
    error,
    fieldsHtml: renderFields(getSetupFields()),
    heading: t("setup.heading"),
    intro: t("setup.welcome"),
    pageTitle: t("setup.title"),
    submitLabel: t("setup.submit"),
  });

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  SuccessCompletePage({
    heading: t("setup.complete.heading"),
    loginLink: t("setup.complete.login_link"),
    messages: [t("setup.complete.message")],
    title: t("setup.complete.title"),
  });
