/**
 * Admin login page template
 */

import { t } from "#i18n";
import { isDemoMode } from "#lib/demo.ts";
import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { loginFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title={t("login.title")}>
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/login">
        <Raw html={renderFields(loginFields)} />
        <button type="submit">{t("login.submit")}</button>
      </CsrfForm>
      {isDemoMode() && (
        <p>
          <a href="/demo/reset">{t("login.reset_database")}</a>
        </p>
      )}
    </Layout>,
  );
