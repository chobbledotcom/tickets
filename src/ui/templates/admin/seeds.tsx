/**
 * Seed data page template - lets admins populate the database with sample data
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { seedsForm } from "#routes/admin/seeds.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { BackButton, SubmitButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
/* jscpd:ignore-end */

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  flashAdminPage(t("admin.seeds.title"), "")(session, error, success)(
    <>
      <CsrfForm action="/admin/seeds">
        <ProseHeading heading={t("admin.seeds.heading")}>
          <p>{t("admin.seeds.intro")}</p>
        </ProseHeading>
        <Raw html={seedsForm.render()} />
        <SubmitButton icon="plus">{t("admin.seeds.submit")}</SubmitButton>
      </CsrfForm>

      <p>
        <BackButton href="/admin">{t("admin.seeds.back")}</BackButton>
      </p>
    </>,
  );
