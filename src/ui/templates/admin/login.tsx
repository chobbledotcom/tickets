/**
 * Admin login page template
 */

import { t } from "#i18n";
import { isDemoMode } from "#shared/demo.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { SubmitButton } from "#templates/components/actions.tsx";
import { getLoginFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string, success?: string): string =>
  String(
    <Layout title={t("login.title")}>
      <Flash error={error} success={success} />
      <CsrfForm action="/admin/login">
        <Raw html={renderFields(getLoginFields())} />
        <SubmitButton icon="log-in">{t("login.submit")}</SubmitButton>
      </CsrfForm>
      {isDemoMode() && (
        <p>
          <a href="/demo/reset">{t("login.reset_database")}</a>
        </p>
      )}
    </Layout>,
  );
