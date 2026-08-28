/**
 * Seed data page template - lets admins populate the database with sample data
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { flashFormPage } from "#templates/admin/admin-page.tsx";
import { BackButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { seedsForm } from "#templates/fields/seeds.ts";
/* jscpd:ignore-end */

/** Seed data admin page */
export const adminSeedsPage = flashFormPage("admin.seeds.title", "", () => (
  <>
    <SaveForm
      action="/admin/seeds"
      submitIcon="plus"
      submitLabel={t("admin.seeds.submit")}
    >
      <ProseHeading heading={t("admin.seeds.heading")}>
        <p>{t("admin.seeds.intro")}</p>
      </ProseHeading>
      <Raw html={seedsForm.render()} />
    </SaveForm>

    <p>
      <BackButton href="/admin">{t("admin.seeds.back")}</BackButton>
    </p>
  </>
));
