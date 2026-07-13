/**
 * Admin login page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { isDemoMode } from "#shared/demo/mode.ts";
import { Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { getLoginFields } from "#templates/fields/admin.ts";
import { layoutPage } from "#templates/layout-page.tsx";
/* jscpd:ignore-end */

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  layoutPage(
    t("login.title"),
    <>
      <Flash {...flashProps(error)} />
      <SaveForm
        action="/admin/login"
        submitIcon="log-in"
        submitLabel={t("login.submit")}
      >
        <Raw html={renderFields(getLoginFields())} />
      </SaveForm>
      {isDemoMode() && (
        <p>
          <a href="/demo/reset">{t("login.reset_database")}</a>
        </p>
      )}
    </>,
  );
