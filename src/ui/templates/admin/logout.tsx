/**
 * Admin logout confirmation page template.
 */

import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { staffAdminPage } from "#templates/admin/admin-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const adminLogoutPage = (session: AdminSession): string =>
  staffAdminPage({
    active: "",
    children: (
      <section aria-labelledby="logout-confirm-heading">
        <h2 id="logout-confirm-heading">{t("logout.confirm_heading")}</h2>
        <p>{t("logout.confirm_body")}</p>
        <CsrfForm action="/admin/logout" class="one-button">
          <SubmitButton class="secondary" icon="log-out">
            {t("nav.logout")}
          </SubmitButton>
        </CsrfForm>
      </section>
    ),
    session,
    staffHeading: <h1>{t("logout.title")}</h1>,
    title: t("logout.title"),
  });
