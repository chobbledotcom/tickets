/**
 * Admin "import a listing or group" page — a single upload form that accepts a
 * JSON blob exported from this or another site (the blob's `kind` decides
 * whether a listing or a group is created).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import { flashFormPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
/* jscpd:ignore-end */

export const adminCatalogImportPage = flashFormPage(
  "catalog_transfer.page_title",
  "/admin/listings",
  (session) => (
    <>
      <ProseHeading heading={t("catalog_transfer.heading")}>
        <p>{t("catalog_transfer.description")}</p>
      </ProseHeading>
      <CsrfForm
        action="/admin/catalog/import"
        enctype="multipart/form-data"
        id="catalog-import"
      >
        <label>
          {t("catalog_transfer.file_label")}
          <input
            accept=".json,application/json"
            name="catalog_file"
            required
            type="file"
          />
        </label>
        <SubmitButton icon="save">
          {t("catalog_transfer.upload_button")}
        </SubmitButton>
      </CsrfForm>

      <GuideFooter
        adminLevel={session.adminLevel}
        href="/admin/guide#import-export"
      >
        {t("catalog_transfer.guide_link")}
      </GuideFooter>
    </>
  ),
);
