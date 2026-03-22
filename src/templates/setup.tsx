/**
 * Setup page templates - initial configuration
 */

import { COUNTRIES, DEFAULT_COUNTRY } from "#lib/countries.ts";
import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { t } from "#i18n";
import { setupFields } from "#templates/fields.ts";
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
        <strong>{t("setup.agreement.controller_title")}</strong> - {t("setup.agreement.controller_text")}
      </li>
      <li>
        <strong>{t("setup.agreement.processor_title")}</strong> - {t("setup.agreement.processor_text")}
      </li>
      <li>
        <strong>{t("setup.agreement.encrypted_title")}</strong> - {t("setup.agreement.encrypted_text")}
      </li>
      <li>
        <strong>{t("setup.agreement.responsibilities_title")}</strong> - {t("setup.agreement.responsibilities_text")}
      </li>
      <li>
        <strong>{t("setup.agreement.breach_title")}</strong> - {t("setup.agreement.breach_text")}
      </li>
      <li>
        <strong>{t("setup.agreement.deletion_title")}</strong> - {t("setup.agreement.deletion_text")}
      </li>
    </ol>
    <p class="password-warning">
      {t("setup.agreement.password_warning")}
    </p>
    <div class="field">
      <label>
        <input type="checkbox" name="accept_agreement" value="yes" required />{t("setup.agreement.accept")}
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
      <h1>{t("setup.heading")}</h1>
      <p>{t("setup.welcome")}</p>
      <Raw html={renderError(error)} />
      <CsrfForm action="/setup/">
        <Raw html={renderFields(setupFields)} />
        <div class="field">
          <label>
            {t("setup.country_label")}
            <select name="country" required>
              {Object.entries(COUNTRIES).map(([code, data]) => (
                <option value={code} selected={code === DEFAULT_COUNTRY}>
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
      <div class="success">
        <p>{t("setup.complete.message")}</p>
      </div>
      <p>
        <a href="/admin/">
          <b>{t("setup.complete.dashboard_link")}</b>
        </a>
      </p>
    </Layout>,
  );
