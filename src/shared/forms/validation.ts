import * as v from "valibot";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import type { ChoiceField, Field } from "#shared/forms/field.ts";
import {
  DATETIME_PARTIAL_ERROR,
  readSubmittedFieldValue,
} from "#shared/forms/submitted-value.ts";
import type { FieldValues } from "#shared/forms/values.ts";

export type FieldValueNormalizer = (
  field: Field,
  value: string | number | null,
) => string | number | null;

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
    : field.type === "number"
      ? trimmed
        ? Number(trimmed)
        : null
      : trimmed;

const choiceSchema = (
  field: ChoiceField<"select" | "checkbox-group">,
): v.PicklistSchema<readonly [string, ...string[]], undefined> => {
  const [first, ...rest] = field.options;
  return v.picklist([first.value, ...rest.map((option) => option.value)]);
};

const hasInvalidChoice = (
  field: ChoiceField<"select" | "checkbox-group">,
  value: string,
): boolean => {
  const values =
    field.type === "checkbox-group"
      ? value.split(",").map((choice) => choice.trim())
      : [value];
  const schema = choiceSchema(field);
  return values.some((choice) => !v.safeParse(schema, choice).success);
};

const requiredFieldError = (field: Field): FieldValidationResult => ({
  error: field.requiredMessage ?? `${field.label} is required`,
  valid: false,
});

const isUnusableParsedValue = (value: string | number | null): boolean =>
  value === null || (typeof value === "number" && !Number.isFinite(value));

const collectFieldValue = (
  form: FormParams,
  field: Field,
): string | FieldValidationResult => {
  const raw = readSubmittedFieldValue(form, field);
  if (raw === null) return { error: DATETIME_PARTIAL_ERROR, valid: false };
  return raw;
};

const validateFieldText = (field: Field, value: string): string | null => {
  if (field.validate && value) {
    const error = field.validate(value);
    if (error) return error;
  }
  if (
    value &&
    (field.type === "select" || field.type === "checkbox-group") &&
    hasInvalidChoice(field, value)
  ) {
    return (
      field.invalidMessage ?? t("error.field_invalid", { label: field.label })
    );
  }
  if (
    "maxlength" in field &&
    field.maxlength !== undefined &&
    value.length > field.maxlength
  ) {
    return `${field.label} must be ${field.maxlength} characters or fewer`;
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
  if (textError) return { error: textError, valid: false };

  const value = parseFieldValue(field, trimmed);
  if (trimmed && isUnusableParsedValue(value)) {
    return {
      error:
        field.invalidMessage ??
        t("error.field_invalid", { label: field.label }),
      valid: false,
    };
  }
  return { valid: true, value };
};

export const validateForm = <T = FieldValues>(
  form: FormParams,
  fields: readonly Field[],
  normalizeValue: FieldValueNormalizer = (_field, value) => value,
): ValidationResult<T> => {
  const values: FieldValues = {};
  for (const field of fields) {
    const result = validateSingleField(form, field);
    if (!result.valid) return result;
    values[field.name] = normalizeValue(field, result.value);
  }
  return { valid: true, values: values as T };
};
