import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms.tsx";
import { type ValidationResult, validateForm } from "#shared/forms.tsx";
import { RECALCULATE_FIELD_NAME } from "#templates/admin/recalculate.tsx";

type AggregateParseResult<T> =
  | { input: T | null; ok: true }
  | { error: string; ok: false };

export const parseEditableAggregateForm = <TValues, TInput>(
  form: FormParams,
  fields: Field[],
  toInput: (values: TValues) => TInput,
): AggregateParseResult<TInput> => {
  if (!fields.some((field) => form.has(field.name))) {
    return { input: null, ok: true };
  }
  const result: ValidationResult<TValues> = validateForm<TValues>(form, fields);
  return result.valid
    ? { input: toInput(result.values), ok: true }
    : { error: result.error, ok: false };
};

export const selectedRecalculationFields = <T extends string>(
  form: FormParams,
  allowed: readonly T[],
): T[] => {
  const selected = new Set(form.getAll(RECALCULATE_FIELD_NAME));
  return allowed.filter((field) => selected.has(field));
};
