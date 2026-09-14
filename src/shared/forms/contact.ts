import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { parseEmail } from "#shared/validation/email.ts";

const invalidEmail = "Please enter a valid email address.";

/** The public contact form's email field. Built per call so its label reads
 *  the catalog inside the requesting page's message groups. */
export const getContactEmailForm = () =>
  defineForm({
    fields: [
      {
        autocomplete: "email",
        invalidMessage: invalidEmail,
        label: t("public.contact_email_label"),
        maxlength: MAX_INPUT_LENGTH,
        name: "email",
        parse: parseEmail,
        required: true,
        requiredMessage: invalidEmail,
        type: "email",
      },
    ] as const,
  });
