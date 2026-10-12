import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { firstFieldRejection } from "#shared/forms/constraints.ts";
import {
  type ChoiceField,
  effectiveMaxLength,
  type Field,
} from "#shared/forms/field.ts";
import {
  DATETIME_PARTIAL_ERROR,
  readSubmittedFieldValue,
} from "#shared/forms/submitted-value.ts";
import type { FieldValues } from "#shared/forms/values.ts";

export type ValidationResult<T = FieldValues> =
  | { valid: true; values: T }
  | { valid: false; error: string };

type FieldValidationResult =
  | { valid: true; value: string | number | null }
  | { valid: false; error: string };

const parseFieldValue = (
  field: Field,
  trimmed: string,
): string | number | null =>
  field.parse
    ? field.parse(trimmed)
    : field.type === "select" && !trimmed
      ? null
      : field.type === "number"
        ? trimmed
          ? Number(trimmed)
          : null
        : trimmed;

const hasInvalidChoice = (
  field: ChoiceField<"select">,
  value: string,
): boolean => !field.options.some((option) => option.value === value);

const requiredFieldError = (field: Field): FieldValidationResult => ({
  error: field.requiredMessage ?? `${field.label} is required`,
  valid: false,
});

const invalidFieldMessage = (field: Field): string =>
  field.invalidMessage ?? t("error.field_invalid", { label: field.label });

const invalidFieldError = (field: Field): FieldValidationResult => ({
  error: invalidFieldMessage(field),
  valid: false,
});

const isUnusableParsedValue = (value: string | number | null): boolean =>
  value === null || (typeof value === "number" && !Number.isFinite(value));

/** The browser applies a number field's min/max attributes. The server
 *  enforces the same declaration, so a hand-built request cannot slip past
 *  them. Fields without a bound stay unbounded. */
const outOfRangeError = (field: Field, value: number): string | null => {
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

const collectFieldValue = (
  form: FormParams,
  field: Field,
): string | FieldValidationResult => {
  if (field.type === "checkbox-group") {
    const selection = form.getRepeatedPicklist(
      field.name,
      field.options.map((option) => option.value),
    );
    if (!selection.ok) {
      const error = field.validate?.(selection.error);
      return error ? { error, valid: false } : invalidFieldError(field);
    }
    return selection.value.join(",");
  }
  const raw = readSubmittedFieldValue(form, field);
  if (raw === null) return { error: DATETIME_PARTIAL_ERROR, valid: false };
  return raw;
};

const validateFieldText = (field: Field, value: string): string | null => {
  if (field.validate && value) {
    const error = field.validate(value);
    if (error) return error;
  }
  if (value && field.type === "select" && hasInvalidChoice(field, value)) {
    return invalidFieldMessage(field);
  }
  const maxlength = effectiveMaxLength(field);
  if (maxlength !== undefined && value.length > maxlength) {
    return t("fields.validation.max_length", {
      label: field.label,
      max: maxlength,
    });
  }
  return null;
};

const validateSingleField = (
  form: FormParams,
  field: Field,
): FieldValidationResult => {
  if (field.type === "file") return { valid: true, value: null };

  const collected = collectFieldValue(form, field);
  if (typeof collected !== "string") return collected;

  let trimmed = collected;
  if (!trimmed && field.defaultValue) trimmed = field.defaultValue;
  if (field.required && !trimmed) return requiredFieldError(field);

  const textError = validateFieldText(field, trimmed);
  if (textError !== null) return { error: textError, valid: false };

  const value = parseFieldValue(field, trimmed);
  if (trimmed && isUnusableParsedValue(value)) {
    return invalidFieldError(field);
  }
  if (typeof value === "number") {
    const rangeError = outOfRangeError(field, value);
    if (rangeError !== null) return { error: rangeError, valid: false };
  }
  return { valid: true, value };
};

export const validateForm = <T = FieldValues>(
  form: FormParams,
  fields: readonly Field[],
): ValidationResult<T> => {
  const values: FieldValues = {};
  for (const field of fields) {
    const result = validateSingleField(form, field);
    if (!result.valid) return result;
    values[field.name] = result.value;
  }
  return { valid: true, values: values as T };
};

/** The numeric half of {@link validateForm} for a settings POST. It refuses a
 *  submitted value the field's declared number type or range turns down, with
 *  the same message a submitted form gets. A blank stays with the form's own
 *  handler, which decides whether the field is required. */
export const formRangeError = (
  form: FormParams,
  fields: readonly Field[],
): string | null =>
  firstFieldRejection(form, fields, (field, raw) => {
    if (field.type !== "number" || !raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return invalidFieldMessage(field);
    return outOfRangeError(field, value);
  });
