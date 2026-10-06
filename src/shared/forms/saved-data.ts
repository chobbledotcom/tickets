import type { FormParams } from "#shared/form-data.ts";
import type { Field, FieldType } from "#shared/forms/field.ts";
import { readSubmittedFieldValue } from "#shared/forms/submitted-value.ts";
import {
  currentRequestStore,
  type RequestSlot,
  requestSlot,
} from "#shared/request-context.ts";

const SENSITIVE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  "password",
  "file",
]);

export type SavedFormState = { form: FormParams | null };

const SAVED_FORM_SLOT: RequestSlot<SavedFormState> = {
  fresh: () => ({ form: null }),
  read: (store) => store.savedForm,
  write: (store, state) => {
    store.savedForm = state;
  },
};

/** The stashed form for this request, allocated on first use. Undefined
 * outside a request. */
const savedFormState = (): SavedFormState | undefined =>
  requestSlot(SAVED_FORM_SLOT);

const stashForm = (form: FormParams | null): void => {
  const slot = savedFormState();
  if (slot) slot.form = form;
};

export const setSavedFormData = (form: FormParams): void => stashForm(form);

export const clearSavedFormData = (): void => stashForm(null);

export const getSavedFormData = (): FormParams | null =>
  currentRequestStore()?.savedForm?.form ?? null;

export const savedFormValue = (name: string): string =>
  currentRequestStore()?.savedForm?.form?.getString(name) ?? "";

/** The submitted value of one field exactly as the operator sent it, or null
 * when this form never carried the field — the distinction a pre-filled
 * field needs: a submitted empty string is the buyer's choice, an absent
 * field is not. Markdown fields keep their indentation because no trimming
 * happens here. */
export const savedFormValueOrNull = (name: string): string | null => {
  const form = currentRequestStore()?.savedForm?.form;
  return form?.has(name) ? form.get(name) : null;
};

/** Return a restorable field value without exposing passwords or files. */
export const getSavedFieldValue = (field: Field): string => {
  const form = currentRequestStore()?.savedForm?.form;
  if (!form || SENSITIVE_FIELD_TYPES.has(field.type)) return "";
  if (field.type === "checkbox-group") return form.getAll(field.name).join(",");
  return readSubmittedFieldValue(form, field) ?? "";
};
