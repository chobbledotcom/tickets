/**
 * Seed data page template - lets admins populate the database with sample data
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { seedsForm } from "#routes/admin/seeds.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { BackButton, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";
/* jscpd:ignore-end */

/**
 * Render a standard admin page: the shared `<Layout>` + `<AdminNav>` chrome with
 * page-specific `children` nested inside. Curried so a page supplies its chrome
 * (`active` tab, `title`, `session`) once and its body as `children`.
 */
export const adminPage =
  (active: string, title: string, session: AdminSession) =>
  (children: JSX.Element): string =>
    String(
      <Layout title={title}>
        <AdminNav active={active} session={session} />
        {children}
      </Layout>,
    );

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  adminPage(
    "",
    t("admin.seeds.title"),
    session,
  )(
    <>
      <CsrfForm action="/admin/seeds">
        <div class="prose">
          <h1>{t("admin.seeds.heading")}</h1>
          <p>{t("admin.seeds.intro")}</p>
        </div>
        <Flash {...flashProps(error, success)} />
        <Raw html={seedsForm.render()} />
        <SubmitButton icon="plus">{t("admin.seeds.submit")}</SubmitButton>
      </CsrfForm>

      <p>
        <BackButton href="/admin">{t("admin.seeds.back")}</BackButton>
      </p>
    </>,
  );
