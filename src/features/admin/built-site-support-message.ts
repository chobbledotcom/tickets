/** The Support message tab's write path: set this site's support message as
 * its hosting provider's readable variable, from the markdown editor's form. */

import { t } from "#i18n";
import {
  saveSiteSupportMessage,
  supportMessageTooLong,
} from "#shared/site-support-message.ts";
import { builtSiteFormPost } from "./built-site-form.ts";
import { answerTab, refuseTab } from "./built-site-tab.ts";

/** POST /admin/built-sites/:id/support-message — persistence is one variable
 * upsert, so an exact replay saves the same text again. */
export const handleSaveSiteSupportMessage = builtSiteFormPost(
  async (site, _session, form, _request) => {
    // Raw, not getString: markdown's own meaning (an indented code block,
    // the blank line before a list) lives in the whitespace.
    const value = form.getRaw("support_message");
    if (supportMessageTooLong(value)) {
      return refuseTab(
        "support-message",
        site.id,
        t("built_sites.support_message_too_long"),
      );
    }
    return answerTab(
      "support-message",
      site.id,
      await saveSiteSupportMessage(site, value),
      t("built_sites.support_message_saved"),
      (error) => t("built_sites.support_message_save_failed", { error }),
    );
  },
);
