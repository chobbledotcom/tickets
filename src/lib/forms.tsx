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
  | "datetime-local";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  min?: number;
  pattern?: string;
  autofocus?: boolean;
  validate?: (value: string) => string | null;
  options?: { value: string; label: string }[];
}

export interface FieldValues {
  [key: string]: string | number | null;
}

type ValidationResult =
  | { valid: true; values: FieldValues }
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

/**
 * Render a single form field
 */
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
      ) : (
        <input
          type={field.type}
          name={field.name}
          value={value || undefined}
          required={field.required}
          placeholder={field.placeholder}
          min={field.min}
          pattern={field.pattern}
          autofocus={field.autofocus}
        />
      )}
      {field.hint && (
        <small style="color: #666; display: block; margin-top: 0.25rem;">
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
 * Parse field value to the appropriate type
 */
const parseFieldValue = (
  field: Field,
  trimmed: string,
): string | number | null =>
  field.type === "number"
    ? trimmed
      ? Number.parseInt(trimmed, 10)
      : null
    : trimmed || null;

/**
 * Validate a single field and return its parsed value
 */
const validateSingleField = (
  form: URLSearchParams,
  field: Field,
): FieldValidationResult => {
  const raw = form.get(field.name) || "";
  const trimmed = raw.trim();

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
 * Parse and validate form data against field definitions
 */
export const validateForm = (
  form: URLSearchParams,
  fields: Field[],
): ValidationResult => {
  const values: FieldValues = {};

  for (const field of fields) {
    const result = validateSingleField(form, field);
    if (!result.valid) return result;
    values[field.name] = result.value;
  }

  return { valid: true, values };
};

/**
 * Render error message if present
 */
export const renderError = (error?: string): string =>
  error ? String(<div class="error">{error}</div>) : "";
