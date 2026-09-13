import type { FormParams } from "#shared/form-data.ts";
import type { Field, FieldType } from "#shared/forms/field.ts";
import { readSubmittedFieldValue } from "#shared/forms/submitted-value.ts";
import { createRequestScoped } from "#shared/request-scoped.ts";

const SENSITIVE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  "password",
  "file",
]);

const savedFormScope = createRequestScoped<{ form: FormParams | null }>(() => ({
  form: null,
}));

export const runWithSavedFormContext = <T>(fn: () => T): T =>
  savedFormScope.run(fn);

export const setSavedFormData = (form: FormParams): void => {
  savedFormScope.current().form = form;
};

export const clearSavedFormData = (): void => {
  savedFormScope.current().form = null;
};

export const getSavedFormData = (): FormParams | null =>
  savedFormScope.current().form;

export const savedFormValue = (name: string): string =>
  savedFormScope.current().form?.getString(name) ?? "";

/** The submitted value of one field, or null when this form never carried
 * it — the distinction a pre-filled field needs: a submitted empty string is
 * the buyer's choice, an absent field is not. */
export const savedFormValueOrNull = (name: string): string | null => {
  const form = savedFormScope.current().form;
  return form?.has(name) ? form.getString(name) : null;
};

/** Return a restorable field value without exposing passwords or files. */
export const getSavedFieldValue = (field: Field): string => {
  const form = savedFormScope.current().form;
  if (!form || SENSITIVE_FIELD_TYPES.has(field.type)) return "";
  if (field.type === "checkbox-group") return form.getAll(field.name).join(",");
  return readSubmittedFieldValue(form, field) ?? "";
};
