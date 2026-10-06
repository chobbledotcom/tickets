import type { FormParams } from "#shared/form-data.ts";
import { getDatetimeValue } from "#shared/forms/datetime-value.ts";
import type { Field } from "#shared/forms/field.ts";
import { parseDateString } from "#shared/validation/date.ts";

export const DATETIME_PARTIAL_ERROR =
  "Please enter a date when providing a time, or leave both blank";

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
    // A usable value is cleaned at this boundary. An unusable one passes
    // through raw, so the field's own validate hook reports its message.
    return parseDateString(raw) ?? raw;
  }
  return form.getString(field.name);
};
