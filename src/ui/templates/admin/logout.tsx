/**
 * Admin logout confirmation page template.
 */

import { t } from "#i18n";
import { staffAdminPage } from "#templates/admin/admin-page.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import type { AdminSession } from "#types";

export const adminLogoutPage = (session: AdminSession): string =>
  staffAdminPage({
    active: "",
    children: (
      <section aria-labelledby="logout-confirm-heading">
        <h2 id="logout-confirm-heading">{t("logout.confirm_heading")}</h2>
        <p>{t("logout.confirm_body")}</p>
        <SaveForm
          action="/admin/logout"
          class="one-button"
          submitClass="secondary"
          submitIcon="log-out"
          submitLabel={t("nav.logout")}
        />
      </section>
    ),
    session,
    staffHeading: <h1>{t("logout.title")}</h1>,
    title: t("logout.title"),
  });
