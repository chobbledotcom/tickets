import { isMaskSentinel } from "#db/settings/mask.ts";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { effectiveMaxLength, type Field } from "#shared/forms/field.ts";

/** The range refusal for a parsed number, from the field's declared min/max.
 *  The browser applies the same attributes. The server answers with the
 *  field's label. */
export const outOfRangeError = (field: Field, value: number): string | null => {
  if (field.min !== undefined && value < field.min) {
    return t("fields.validation.min_value", {
      label: field.label,
      min: field.min,
    });
  }
  if (field.max !== undefined && value > field.max) {
    return t("fields.validation.max_value", {
      label: field.label,
      max: field.max,
    });
  }
  return null;
};

/** The refusal for a value the field's declared type turns down. */
export const invalidFieldMessage = (field: Field): string =>
  field.invalidMessage ?? t("error.field_invalid", { label: field.label });

/** One field's submitted value against one constraint: the refusal, or null. */
type FieldValueCheck = (field: Field, value: string) => string | null;

/** The numeric refusal for one submitted value, or null: a non-number field,
 *  a blank, and the handler's requiredness all stay outside this check. */
const numberError: FieldValueCheck = (field, value) => {
  if (field.type !== "number" || !value) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return invalidFieldMessage(field);
  return outOfRangeError(field, number);
};

/** The settings POST guard. It refuses the first submitted value a field
 *  constraint turns down. The refusal covers a length past the field's cap
 *  and a number its declared type or range turns down. The message is the
 *  one a submitted form gets. A masked secret means "unchanged". A blank's
 *  requiredness is the caller's decision. Neither reaches the numeric
 *  check. */
export const formFieldError = (
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
    const numeric = numberError(field, value);
    if (numeric !== null) return numeric;
  }
  return null;
};
