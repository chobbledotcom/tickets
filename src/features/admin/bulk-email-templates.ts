/**
 * Bulk-email template CRUD: the owner's saved subject/body pairs. Saving
 * starts from the validated compose form. Deleting runs the typed
 * confirmation round-trip used for other named resources.
 */

import { countRows } from "#db/client.ts";
import { t } from "#i18n";
import {
  COMPOSE_PATH,
  validatedEmailPost,
} from "#routes/admin/bulk-email-form.ts";
import { errorRedirect } from "#routes/response.ts";
import { targetQuery } from "#shared/bulk-email-targets/registry.ts";
import type { BulkEmailTarget } from "#shared/bulk-email-targets/types.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
import { emailTemplateRecord } from "#shared/records/email-templates.ts";
import { ok } from "#shared/response.ts";
import type { WriteVerdict } from "#shared/rest/record.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { parsePositiveInt as parsePositiveIntId } from "#shared/validation/number.ts";
import { bulkEmailTemplateDeletePage } from "#templates/admin/bulk-email.tsx";

/** Flash back to the compose page with the saved template selected. */
const templateSavedResponse = (
  target: BulkEmailTarget,
  templateId: number,
  message: string,
): Response =>
  ok(`${COMPOSE_PATH}${targetQuery(target)}&template=${templateId}`, message);

/** Answer one template save: its flash redirect, or the refusal. The template
 *  was removed between the compose page load and this save. The record's save
 *  command never refuses a submitted template. */
const answerTemplateSave = (
  verdict: WriteVerdict<{ id: number }>,
  target: BulkEmailTarget,
  message: string,
): Response => {
  if (verdict.kind === "written") {
    return templateSavedResponse(target, verdict.row.id, message);
  }
  return errorRedirect(
    `${COMPOSE_PATH}${targetQuery(target)}`,
    t("bulk_email.template_missing"),
  );
};

/** POST /admin/emails/templates — save or update a template. */
export const handleTemplateSavePost = validatedEmailPost(
  "/admin/emails/templates",
  async ({ subject, body, target }, form) => {
    const updateExisting = form.getFlag("update_existing");
    const templateIdParam = form.get("template_id");
    const templateId = templateIdParam
      ? parsePositiveIntId(templateIdParam)
      : null;

    if (updateExisting && templateId !== null) {
      const verdict = await emailTemplateRecord.update(templateId, {
        body,
        subject,
      });
      return answerTemplateSave(
        verdict,
        target,
        t("bulk_email.template_updated_flash"),
      );
    }

    const count = await countRows("email_templates");
    if (count >= MAX_EMAIL_TEMPLATES) {
      return errorRedirect(
        `${COMPOSE_PATH}${targetQuery(target)}`,
        t("bulk_email.template_limit_reached", { max: MAX_EMAIL_TEMPLATES }),
      );
    }
    const verdict = await emailTemplateRecord.create({ body, subject });
    return answerTemplateSave(
      verdict,
      target,
      t("bulk_email.template_saved_flash"),
    );
  },
);

/**
 * The template delete routes, bound from the template record's declaration.
 * The confirmation page decrypts the subject with the owner's private key.
 */
const pages = recordPages(emailTemplateRecord, {
  deleteSuccessMessage: "Template deleted.",
  deleteSuccessPath: `${COMPOSE_PATH}?audience=active`,
  renderDelete: bulkEmailTemplateDeletePage,
  routes: { delete: "emailTemplateDelete" },
  skip: ["new", "edit"],
});

export const templateDelete = {
  get: pages.deleteGet,
  post: pages.deletePost,
};
