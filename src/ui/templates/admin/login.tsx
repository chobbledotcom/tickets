/**
 * Admin login page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { isDemoMode } from "#shared/demo/mode.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { getLoginFields } from "#templates/fields/admin.ts";
import { Layout } from "#templates/layout.tsx";
/* jscpd:ignore-end */

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title={t("login.title")}>
      <Flash {...flashProps(error)} />
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
