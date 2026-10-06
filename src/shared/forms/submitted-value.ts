import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { parseDateString } from "#shared/validation/date.ts";

export const DATETIME_PARTIAL_ERROR =
  "Please enter a date when providing a time, or leave both blank";

const getDatetimeValue = (form: FormParams, name: string): string | null => {
  const date = form.getString(`${name}_date`);
  const time = form.getString(`${name}_time`);
  if (!date && !time) return "";
  if (!date || !time) return null;
  // An unusable date half answers null like the partial form does: the field
  // reports its error instead of composing a value a comparison cannot order.
  const cleaned = parseDateString(date);
  return cleaned === null ? null : `${cleaned}T${time}`;
};

/** Read one field from submitted form data using the field's input shape.
 *  A date-typed field is cleaned at this boundary: trimmed and validated as
 *  a real calendar day, or null when the value is unusable. Every surface
 *  that reads a form gets the cleaned value without opting in. */
export const readSubmittedFieldValue = (
  form: FormParams,
  field: Field,
): string | null => {
  if (field.type === "datetime") {
    return getDatetimeValue(form, field.name);
  }
  if (field.type === "date") {
    const raw = form.getString(field.name);
    if (raw.trim() === "") return "";
    return parseDateString(raw);
  }
  return form.getString(field.name);
};
