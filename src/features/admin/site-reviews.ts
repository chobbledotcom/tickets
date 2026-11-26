/** Admin reviews editor: one markdown file, saved as the public reviews page.
 *
 *  The route lives under the Site area and uses the same owner+editor access
 *  as the Pages and News editors. A save is refused unless the markdown parses
 *  as a complete reviews file, so a broken edit never reaches the public page.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { SITE_FORM, sitePage } from "#routes/auth.ts";
import { readSubmittedMarkdown } from "#shared/forms/submitted-value.ts";
import { maxTextareaValidator } from "#shared/forms/textarea-limit.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { parseReviewsSource } from "#shared/reviews/parse.ts";
import { REVIEWS_SOURCE } from "#shared/reviews.ts";
import { validationMessage } from "#shared/validation-message.ts";
import { adminSiteReviewsPage } from "#templates/admin/site.tsx";

const REVIEWS_FILE_LABEL = "Reviews file";

/** The parser's message, or null when the markdown is a complete reviews file. */
const reviewsError = (value: string): string | null =>
  validationMessage(() => {
    parseReviewsSource(REVIEWS_FILE_LABEL, value);
  });

/** Handle GET /admin/site/reviews - the stored markdown, or the shipped
 *  sample until the owner saves their first file. */
const handleSiteReviewsGet = sitePage((session, _request, flash) =>
  adminSiteReviewsPage(
    session,
    settings.reviewsMarkdown || REVIEWS_SOURCE,
    settings.features.reviews,
    flash.error,
    flash.success,
  ),
);

/** Handle POST /admin/site/reviews - validate and save the markdown. */
const handleSiteReviewsPost = settingsHandler({
  auth: SITE_FORM,
  extract: (form) => readSubmittedMarkdown(form, "reviewsMarkdown"),
  log: () => t("site.reviews.updated"),
  redirectTo: "/admin/site/reviews",
  save: settings.update.reviewsMarkdown,
  validate: (value) =>
    maxTextareaValidator(MAX_TEXTAREA_LENGTH, REVIEWS_FILE_LABEL)(value) ??
    reviewsError(value),
});

/** The reviews editor routes, spread into the Site area's route table. */
export const siteReviewRoutes = {
  "GET /admin/site/reviews": handleSiteReviewsGet,
  "POST /admin/site/reviews": handleSiteReviewsPost,
} as const;
