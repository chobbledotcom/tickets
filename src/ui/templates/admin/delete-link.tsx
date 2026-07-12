/**
 * The "Delete" link cell for a row on an admin collection list (News, Pages).
 * Hidden when the site is read-only, like every other write action.
 */

import { t } from "#i18n";
import { WritableOnly } from "#templates/admin/writable-only.tsx";

/** Builds the delete-link cell for rows under `listPath`
 * (`<listPath>/<id>/delete`). */
export const rowDeleteLink =
  (listPath: string) =>
  ({ id }: { id: number }): JSX.Element => (
    <WritableOnly>
      <a href={`${listPath}/${id}/delete`}>{t("common.delete")}</a>
    </WritableOnly>
  );
