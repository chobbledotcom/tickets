/** The Support message tab's write path: set this site's support message as
 * its hosting provider's readable variable, from the markdown editor's form. */

import { t } from "#i18n";
import {
  saveSiteSupportMessage,
  supportMessageTooLong,
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
    if (supportMessageTooLong(value)) {
      return builtSiteTabError(
        id,
        "support-message",
        t("built_sites.support_message_too_long"),
      );
    }
    return saveSupportMessageResult(t("built_sites.support_message_saved"))(
      id,
      await saveSiteSupportMessage(site, value),
    );
  },
);
