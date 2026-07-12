/**
 * Setup page templates - initial configuration
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { COUNTRIES, DEFAULT_COUNTRY } from "#shared/countries.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { getSetupFields } from "#templates/fields/admin.ts";
import { Layout } from "#templates/layout.tsx";

/* jscpd:ignore-end */

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
 * Shared shell for the setup and join password forms: a titled page with a
 * prose heading and intro, the flash message, the rendered form fields, then
 * whatever extra controls and submit button the page adds as `children`.
 */
export const AuthFormPage = ({
  title,
  action,
  heading,
  intro,
  formHtml,
  error,
  children,
}: {
  title: string;
  action: string;
  heading: string;
  intro: string;
  formHtml: string;
  error?: string | undefined;
  children: JSX.Element | JSX.Element[];
}): string =>
  String(
    <Layout title={title}>
      <CsrfForm action={action}>
        <div class="prose">
          <h1>{heading}</h1>
          <p>{intro}</p>
        </div>
        <Flash error={error} />
        <Raw html={formHtml} />
        {children}
      </CsrfForm>
    </Layout>,
  );

/**
 * Initial setup page
 */
export const setupPage = (error?: string): string =>
  AuthFormPage({
    action: "/setup/",
    children: [
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
      </div>,
      <DataControllerAgreement />,
      <button type="submit">{t("setup.submit")}</button>,
    ],
    error,
    formHtml: renderFields(getSetupFields()),
    heading: t("setup.heading"),
    intro: t("setup.welcome"),
    title: t("setup.title"),
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
