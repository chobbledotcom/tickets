import { isMaskSentinel } from "#db/settings/mask.ts";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { effectiveMaxLength, type Field } from "#shared/forms/field.ts";

/** Refuse long submitted values before custom validators or external calls. */
export const formLengthError = (
  form: FormParams,
  fields: readonly Field[],
): string | null => {
  for (const field of fields) {
    const value = form.getString(field.name);
    if (isMaskSentinel(value)) continue;
    const max = effectiveMaxLength(field);
    if (max !== undefined && value.length > max) {
      return t("fields.validation.max_length", { label: field.label, max });
    }
  }
  return null;
};
