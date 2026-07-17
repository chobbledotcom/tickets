import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";

export const DATETIME_PARTIAL_ERROR =
  "Please enter a date when providing a time, or leave both blank";

const getDatetimeValue = (form: FormParams, name: string): string | null => {
  const date = form.getString(`${name}_date`);
  const time = form.getString(`${name}_time`);
  if (date && time) return `${date}T${time}`;
  if (date && !time) return `${date}T00:00`;
  if (!date && !time) return "";
  return null;
};

const parseCheckboxGroup = (form: FormParams, name: string): string =>
  form
    .getAll(name)
    .map((value) => value.trim())
    .filter((value) => value)
    .join(",");

/** Read one field from submitted form data using the field's input shape. */
export const readSubmittedFieldValue = (
  form: FormParams,
  field: Field,
): string | null => {
  if (field.type === "checkbox-group") {
    return parseCheckboxGroup(form, field.name);
  }
  if (field.type === "datetime") {
    return getDatetimeValue(form, field.name);
  }
  return form.getString(field.name);
};
