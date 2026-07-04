/**
 * Admin "import a listing or group" page — a single upload form that accepts a
 * JSON blob exported from this or another site (the blob's `kind` decides
 * whether a listing or a group is created).
 */

import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { adminPage } from "#templates/admin/seeds.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const adminCatalogImportPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  adminPage(
    "/admin/listings",
    t("catalog_transfer.page_title"),
    session,
  )(
    <>
      <div class="prose">
        <h1>{t("catalog_transfer.heading")}</h1>
        <p>{t("catalog_transfer.description")}</p>
      </div>
      <Flash error={error} success={success} />
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
    </>,
  );
