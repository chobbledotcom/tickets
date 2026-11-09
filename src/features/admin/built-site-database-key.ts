/** The database key option on a built site: the write behind its route. */

import { logActivity } from "#db/activity-log.ts";
import { t } from "#i18n";
import { rotateDatabaseKey } from "#shared/database-key-rotation.ts";
import { builtSiteFormPost } from "./built-site-form.ts";
import { answerTab } from "./built-site-tab.ts";

const handleRotateDatabaseKey = builtSiteFormPost(
  async (site, _session, _form, _request) => {
    const outcome = await rotateDatabaseKey(site);
    if (outcome.ok) {
      await logActivity(`Rotated database key for '${site.name}'`);
    }
    return answerTab(
      "secrets",
      site.id,
      outcome,
      t("built_sites.database_key_rotated"),
    );
  },
);

/** The one route this option writes through, named beside its handler. */
export const databaseKeyRoutes = {
  "POST /admin/built-sites/:id/rotate-database-key": handleRotateDatabaseKey,
};
