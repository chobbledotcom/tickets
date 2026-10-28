/**
 * Bulk-email template CRUD: the owner's saved subject/body pairs. Saving
 * starts from the validated compose form. Deleting runs the typed
 * confirmation round-trip used for other named resources.
 */

import { decryptWithOwnerKey, encryptWithOwnerKey } from "#crypto/hybrid.ts";
import {
  countEmailTemplates,
  deleteEmailTemplate,
  getRawEmailTemplate,
  insertEmailTemplate,
  updateEmailTemplate,
} from "#db/email-templates.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  COMPOSE_PATH,
  validatedEmailPost,
} from "#routes/admin/bulk-email-form.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { errorRedirect } from "#routes/response.ts";
import { targetQuery } from "#shared/bulk-email-targets/registry.ts";
import type { BulkEmailTarget } from "#shared/bulk-email-targets/types.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
/* jscpd:ignore-start */
import { ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { parsePositiveInt as parsePositiveIntId } from "#shared/validation/number.ts";
/* jscpd:ignore-end */
import { bulkEmailTemplateDeletePage } from "#templates/admin/bulk-email.tsx";

/** Flash back to the compose page with the saved template selected. */
const templateSavedResponse = (
  target: BulkEmailTarget,
  templateId: number,
  message: string,
): Response =>
  ok(`${COMPOSE_PATH}${targetQuery(target)}&template=${templateId}`, message);

/** POST /admin/emails/templates — save or update a template. */
export const handleTemplateSavePost = validatedEmailPost(
  async ({ subject, body, target }, form) => {
    const encSubject = await encryptWithOwnerKey(subject, settings.publicKey);
    const encBody = await encryptWithOwnerKey(body, settings.publicKey);
    const updateExisting = form.getFlag("update_existing");
    const templateIdParam = form.get("template_id");
    const templateId = templateIdParam
      ? parsePositiveIntId(templateIdParam)
      : null;

    if (updateExisting && templateId !== null) {
      const existing = await getRawEmailTemplate(templateId);
      if (!existing) {
        return errorRedirect(
          `${COMPOSE_PATH}${targetQuery(target)}`,
          t("bulk_email.template_missing"),
        );
      }
      await updateEmailTemplate(templateId, encSubject, encBody);
      return templateSavedResponse(
        target,
        templateId,
        t("bulk_email.template_updated_flash"),
      );
    }

    const count = await countEmailTemplates();
    if (count >= MAX_EMAIL_TEMPLATES) {
      return errorRedirect(
        `${COMPOSE_PATH}${targetQuery(target)}`,
        t("bulk_email.template_limit_reached", { max: MAX_EMAIL_TEMPLATES }),
      );
    }
    const newId = await insertEmailTemplate(encSubject, encBody);
    return templateSavedResponse(
      target,
      newId,
      t("bulk_email.template_saved_flash"),
    );
  },
);

/**
 * Typed-confirmation delete for a template, matching the round-trip flow used
 * for other named resources. The subject is encrypted. The owner's private
 * key decrypts it twice: once to display the confirmation page, once as the
 * identifier the owner must re-type.
 */
export const templateDelete = createConfirmedHandlers<{
  id: number;
  subject: string;
}>({
  identifier: (template) => template.subject,
  identifierLabel: t("bulk_email.name_label"),
  load: async (id) => {
    const raw = await getRawEmailTemplate(id);
    if (!raw) return null;
    const privateKey = await requireRequestPrivateKey();
    return {
      id,
      subject: await decryptWithOwnerKey(raw.subject, privateKey),
    };
  },
  onConfirm: async (_template, id) => {
    await deleteEmailTemplate(id);
  },
  path: "/admin/emails/templates/:id/delete",
  render: bulkEmailTemplateDeletePage,
  successMessage: "Template deleted.",
  successRedirect: `${COMPOSE_PATH}?audience=active`,
});
