/** The database key section of a built site's Secrets tab: the one control that
 * replaces the site's database key. It renders only where the host holds the
 * settings the rotation reads, so the button never offers work the route
 * refuses. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import {
  DATABASE_PROVIDER_LABEL_KEYS,
  databaseKeyRotationAccess,
} from "#shared/database-key-rotation.ts";
import { ConfirmActionButton } from "#templates/admin/built-sites/action-forms.tsx";

export const DatabaseKeySection = ({
  site,
}: {
  site: BuiltSite;
}): JSX.Element => {
  const access = databaseKeyRotationAccess(site);
  return (
    <div class="prose">
      <h3>{t("built_sites.database_key_title")}</h3>
      {access.ok ? (
        <>
          <p>{t("built_sites.database_key_intro")}</p>
          <p>
            <strong>{t("built_sites.database_key_provider")}</strong>{" "}
            {t(DATABASE_PROVIDER_LABEL_KEYS[access.provider])}
          </p>
          <ConfirmActionButton
            action="rotate-database-key"
            confirmKey="built_sites.database_key_confirm"
            icon="rotate-ccw"
            labelKey="built_sites.database_key_rotate"
            siteId={site.id}
          />
        </>
      ) : (
        <p>{access.error}</p>
      )}
    </div>
  );
};
