import { isMaskSentinel } from "#db/settings/mask.ts";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { effectiveMaxLength, type Field } from "#shared/forms/field.ts";

/** Read each submitted field once and return the first refusal one of them
 *  gives its value, or null when every field passes. The per-field rule is
 *  the caller's callback. */
export const firstFieldRejection = (
  form: FormParams,
  fields: readonly Field[],
  reject: (field: Field, value: string) => string | null,
): string | null => {
  for (const field of fields) {
    const error = reject(field, form.getString(field.name));
    if (error !== null) return error;
  }
  return null;
};

/** Refuse long submitted values before custom validators or external calls. */
export const formLengthError = (
  form: FormParams,
  fields: readonly Field[],
): string | null =>
  firstFieldRejection(form, fields, (field, value) => {
    if (isMaskSentinel(value)) return null;
    const max = effectiveMaxLength(field);
    if (max !== undefined && value.length > max) {
      return t("fields.validation.max_length", { label: field.label, max });
    }
    return null;
  });
