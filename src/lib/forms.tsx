/**
 * Minimal form framework for declarative form handling
 */

import { map, pipe, reduce } from "#fp";
import { Raw } from "#jsx/jsx-runtime.ts";

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export type FieldType =
  | "text"
  | "number"
  | "email"
  | "url"
  | "password"
  | "textarea"
  | "select"
  | "checkbox-group"
  | "date"
  | "datetime"
  | "file";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  min?: number;
  inputmode?: string;
  maxlength?: number;
  pattern?: string;
  accept?: string;
  autofocus?: boolean;
  validate?: (value: string) => string | null;
  options?: { value: string; label: string }[];
}

export interface FieldValues {
  [key: string]: string | number | null;
}

export type ValidationResult<T = FieldValues> =
  | { valid: true; values: T }
  | { valid: false; error: string };

type FieldValidationResult =
  | { valid: true; value: string | number | null }
  | { valid: false; error: string };

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** Render select options HTML */
const renderSelectOptions = (
  options: { value: string; label: string }[],
  selectedValue: string,
): string =>
  options
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.value)}"${opt.value === selectedValue ? " selected" : ""}>${escapeHtml(opt.label)}</option>`,
    )
    .join("");

/** Render checkbox group HTML (multiple checkboxes with the same name) */
const renderCheckboxGroup = (
  name: string,
  options: { value: string; label: string }[],
  selectedValues: Set<string>,
): string =>
  `<fieldset class="checkbox-group">${options
    .map(
      (opt) =>
        `<label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(opt.value)}"${selectedValues.has(opt.value) ? " checked" : ""}> ${escapeHtml(opt.label)}</label>`,
    )
    .join("")}</fieldset>`;

/** Render split date and time inputs for a datetime field */
const renderDatetimeInputs = (
  name: string,
  { date, time }: { date: string; time: string },
): string =>
  `<input type="date" name="${escapeHtml(name)}_date" placeholder="Date"${date ? ` value="${escapeHtml(date)}"` : ""}>`
  + `<input type="time" name="${escapeHtml(name)}_time" placeholder="Time"${time ? ` value="${escapeHtml(time)}"` : ""}>`;

const DATETIME_PARTIAL_ERROR = "Please enter both a date and time, or leave both blank";

/** Combine date and time form values into a datetime string, or null on partial fill */
const getDatetimeValue = (
  form: URLSearchParams,
  name: string,
): string | null => {
  const date = (form.get(`${name}_date`) || "").trim();
  const time = (form.get(`${name}_time`) || "").trim();
  if (date && time) return `${date}T${time}`;
  if (!date && !time) return "";
  return null;
};

/** Split a datetime value (YYYY-MM-DDTHH:MM) into date and time parts */
const splitDatetime = (value: string): { date: string; time: string } => {
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

export const renderField = (field: Field, value: string = ""): string =>
  String(
    <label>
      {field.label}
      {field.type === "textarea" ? (
        <textarea
          name={field.name}
          rows="3"
          required={field.required}
          placeholder={field.placeholder}
        >
          <Raw html={escapeHtml(value)} />
        </textarea>
      ) : field.type === "select" && field.options ? (
        <Raw
          html={`<select name="${escapeHtml(field.name)}" id="${escapeHtml(field.name)}">${renderSelectOptions(field.options, value)}</select>`}
        />
      ) : field.type === "checkbox-group" && field.options ? (
        <Raw
          html={renderCheckboxGroup(field.name, field.options, new Set(value ? value.split(",").map((v) => v.trim()) : []))}
        />
      ) : field.type === "datetime" ? (
        <Raw
          html={renderDatetimeInputs(field.name, splitDatetime(value))}
        />
      ) : field.type === "file" ? (
        <input
          type="file"
          name={field.name}
          accept={field.accept}
        />
      ) : (
        <input
          type={field.type}
          name={field.name}
          value={value || undefined}
          required={field.required}
          placeholder={field.placeholder}
          min={field.min}
          inputmode={field.inputmode}
          maxlength={field.maxlength}
          pattern={field.pattern}
          autofocus={field.autofocus}
        />
      )}
      {field.hint && (
        <small>
          {field.hint}
        </small>
      )}
    </label>
  );

/**
 * Render multiple fields with values
 */
export const renderFields = (
  fields: Field[],
  values: FieldValues = {},
): string =>
  pipe(
    map((f: Field) => renderField(f, String(values[f.name] ?? ""))),
    joinStrings,
  )(fields);

/**
 * Parse field value to the appropriate type.
 * Empty strings stay as "" for text fields; empty numbers become null.
 */
const parseFieldValue = (
  field: Field,
  trimmed: string,
): string | number | null =>
  field.type === "number"
    ? trimmed
      ? Number.parseInt(trimmed, 10)
      : null
    : trimmed;

/**
 * Validate a single field and return its parsed value.
 * For checkbox-group fields, collects all checked values via getAll()
 * and joins them as a comma-separated string.
 */
const validateSingleField = (
  form: URLSearchParams,
  field: Field,
): FieldValidationResult => {
  // File fields are handled separately via FormData, not URLSearchParams
  if (field.type === "file") return { valid: true, value: null };

  let trimmed: string;

  if (field.type === "datetime") {
    const result = getDatetimeValue(form, field.name);
    if (result === null) return { valid: false, error: DATETIME_PARTIAL_ERROR };
    if (!result) {
      if (field.required) return { valid: false, error: `${field.label} is required` };
      return { valid: true, value: null };
    }
    trimmed = result;
  } else if (field.type === "checkbox-group") {
    trimmed = form.getAll(field.name).map((v) => v.trim()).filter((v) => v).join(",");
  } else {
    trimmed = (form.get(field.name) || "").trim();
  }

  if (field.required && !trimmed) {
    return { valid: false, error: `${field.label} is required` };
  }

  if (field.validate && trimmed) {
    const error = field.validate(trimmed);
    if (error) return { valid: false, error };
  }

  return { valid: true, value: parseFieldValue(field, trimmed) };
};

/**
 * Parse and validate form data against field definitions.
 *
 * Supply a type parameter to get strongly-typed values back:
 *   validateForm<EventFormValues>(form, eventFields)
 *
 * Without a type parameter, values default to the loose FieldValues dict.
 */
export const validateForm = <T = FieldValues>(
  form: URLSearchParams,
  fields: Field[],
): ValidationResult<T> => {
  const values: FieldValues = {};

  for (const field of fields) {
    const result = validateSingleField(form, field);
    if (!result.valid) return result;
    values[field.name] = result.value;
  }

  return { valid: true, values: values as T };
};

/**
 * Render error message if present
 */
export const renderError = (error?: string): string =>
  error ? String(<div class="error">{error}</div>) : "";
