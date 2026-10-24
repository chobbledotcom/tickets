/**
 * The bulk-email compose form seam: the compose path plus the validation
 * every owner POST that starts from the compose form runs first.
 */

import { t } from "#i18n";
import { formPost, OWNER_FORM } from "#routes/auth.ts";
import { errorRedirect } from "#routes/response.ts";
import { validateDraftInput } from "#shared/bulk-email.ts";
import {
  targetFromForm,
  targetQuery,
} from "#shared/bulk-email-targets/registry.ts";
import type { BulkEmailTarget } from "#shared/bulk-email-targets/types.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { RequestRoute } from "#shared/response-steps.ts";

export const COMPOSE_PATH = "/admin/emails";

export type ValidatedEmailForm = {
  target: BulkEmailTarget;
  subject: string;
  body: string;
  marketing: boolean;
};

/** Validate the target and message fields from a compose form, returning a
 * redirect Response on failure or the extracted fields on success. */
const validateFormBody = async (
  form: FormParams,
): Promise<Response | ValidatedEmailForm> => {
  const target = await targetFromForm(form);
  if (!target) {
    return errorRedirect(COMPOSE_PATH, t("bulk_email.listing_gone"));
  }
  const validation = validateDraftInput({
    body: form.getString("body"),
    marketing: form.getFlag("marketing"),
    subject: form.getString("subject"),
    target,
  });
  if (!validation.valid) {
    return errorRedirect(
      `${COMPOSE_PATH}${targetQuery(target)}`,
      validation.error,
      "bulk-email",
    );
  }
  return {
    body: validation.draft.body,
    marketing: validation.draft.marketing,
    subject: validation.draft.subject,
    target,
  };
};

/** An owner POST that starts from a validated compose form: bounce back on a
 * validation redirect, else hand the extracted fields (and raw form) on. */
export const validatedEmailPost = (
  next: (fields: ValidatedEmailForm, form: FormParams) => Promise<Response>,
): RequestRoute =>
  formPost(OWNER_FORM)(async (form) => {
    const result = await validateFormBody(form);
    return result instanceof Response ? result : next(result, form);
  });
