/**
 * Admin login page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { getLoginForm } from "#templates/fields/admin.ts";
import { layoutPage } from "#templates/layout-page.tsx";
/* jscpd:ignore-end */

/**
 * Admin login page. `returnPath` is the validated page login returns to. It
 * is a hidden field in the form, so a failed attempt keeps it.
 */
export const adminLoginPage = (
  error?: string,
  returnPath?: string | null,
): string =>
  layoutPage(
    t("login.title"),
    <>
      <Flash {...flashProps(error)} />
      <SaveForm
        action="/admin/login"
        submitIcon="log-in"
        submitLabel={t("login.submit")}
      >
        <Raw html={getLoginForm().render()} />
        <ReturnUrlField returnUrl={returnPath ?? undefined} />
      </SaveForm>
      {isDemoMode() && (
        <p>
          <a href="/demo/reset">{t("login.reset_database")}</a>
        </p>
      )}
    </>,
  );
