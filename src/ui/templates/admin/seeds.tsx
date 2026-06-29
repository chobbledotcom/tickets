/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { seedsForm } from "#routes/admin/seeds.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { BackButton, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title={t("admin.seeds.title")}>
      <AdminNav active="" session={session} />
      <CsrfForm action="/admin/seeds">
        <div class="prose">
          <h1>{t("admin.seeds.heading")}</h1>
          <p>{t("admin.seeds.intro")}</p>
        </div>
        <Flash
          {...(error !== undefined ? { error } : {})}
          {...(success !== undefined ? { success } : {})}
        />
        <Raw html={seedsForm.render()} />
        <SubmitButton icon="plus">{t("admin.seeds.submit")}</SubmitButton>
      </CsrfForm>

      <p>
        <BackButton href="/admin">{t("admin.seeds.back")}</BackButton>
      </p>
    </Layout>,
  );
