/** The database key section of a built site's Secrets tab: the one control that
 * replaces the site's database key. It renders only where the host holds the
 * settings the rotation reads, so the button never offers work the route
 * refuses. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import {
  DATABASE_KEY_PAUSE_SECONDS,
  DATABASE_PROVIDER_LABEL_KEYS,
  databaseKeyRotationAccess,
} from "#shared/database-key-rotation.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { ConfirmActionButton } from "#templates/admin/built-sites/action-forms.tsx";
import type { AdminSession } from "#types";

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

/**
 * The page the rotate route answers. The database needs a short pause after it
 * removes every key. A meta refresh therefore opens the step that makes the
 * new key when the pause ends. Until then the site cannot reach its database,
 * which the page says.
 */
export const DatabaseKeyRotationPage = ({
  finishUrl,
  session,
  site,
}: {
  finishUrl: string;
  session: AdminSession;
  site: BuiltSite;
}): string =>
  renderAdminPageSpec({
    active: "/admin/built-sites",
    body: (
      <div class="prose">
        <h1>{t("built_sites.database_key_rotating_title")}</h1>
        <p>
          {t("built_sites.database_key_rotating_body", { site: site.name })}
        </p>
        <p>{t("built_sites.database_key_rotating_wait")}</p>
      </div>
    ),
    headExtra: `<meta http-equiv="refresh" content="${DATABASE_KEY_PAUSE_SECONDS};url=${escapeHtml(
      finishUrl,
    )}">`,
    session,
    title: t("built_sites.database_key_rotating_title"),
  });
