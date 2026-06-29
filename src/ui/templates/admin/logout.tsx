/**
 * Admin logout confirmation page template.
 */

import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

const LogoutAgentHeader = (): JSX.Element => {
  // Only rendered for agent-class users (bare header, no staff nav).
  markAdminFooter("agent");
  return (
    <header class="agent-header">
      <h1>{t("logout.title")}</h1>
    </header>
  );
};

export const adminLogoutPage = (session: AdminSession): string =>
  String(
    <Layout title={t("logout.title")}>
      {session.adminLevel === "agent" ? (
        <LogoutAgentHeader />
      ) : (
        <>
          <AdminNav active="" session={session} />
          <h1>{t("logout.title")}</h1>
        </>
      )}
      <section aria-labelledby="logout-confirm-heading">
        <h2 id="logout-confirm-heading">{t("logout.confirm_heading")}</h2>
        <p>{t("logout.confirm_body")}</p>
        <CsrfForm action="/admin/logout" class="one-button">
          <SubmitButton class="secondary" icon="log-out">
            {t("nav.logout")}
          </SubmitButton>
        </CsrfForm>
      </section>
    </Layout>,
  );
