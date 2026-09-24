/** The Support message tab's write path: set this site's support message as a
 * Bunny variable from the markdown editor's form. */

import { t } from "#i18n";
import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  saveSiteSupportMessage,
} from "#shared/site-support-message.ts";
import {
  builtSiteAction,
  builtSiteTabError,
  builtSiteTabResult,
} from "./built-site-action.ts";

const saveSupportMessageResult = builtSiteTabResult(
  "support-message",
  (error) => t("built_sites.support_message_save_failed", { error }),
);

/** POST /admin/built-sites/:id/support-message — persistence is one variable
 * upsert, so an exact replay saves the same text again. */
export const handleSaveSiteSupportMessage = builtSiteAction(
  async (site, form, id) => {
    const value = form.getString("support_message");
    if (value.length > SUPPORT_MESSAGE_MAX_LENGTH) {
      return builtSiteTabError(
        id,
        "support-message",
        t("built_sites.support_message_too_long", {
          max: String(SUPPORT_MESSAGE_MAX_LENGTH),
        }),
      );
    }
    return saveSupportMessageResult(t("built_sites.support_message_saved"))(
      id,
      await saveSiteSupportMessage(site, value),
    );
  },
);
