/**
 * Minimal form framework for declarative form handling
 */

import { map, pipe, reduce } from "#fp";

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
  | "textarea";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  min?: number;
  pattern?: string;
  validate?: (value: string) => string | null;
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

const renderInput = (field: Field, value: string): string => {
  const attrs = [
    `type="${field.type}"`,
    `id="${field.name}"`,
    `name="${field.name}"`,
    value ? `value="${escapeHtml(value)}"` : "",
    field.required ? "required" : "",
    field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : "",
    field.min !== undefined ? `min="${field.min}"` : "",
    field.pattern ? `pattern="${field.pattern}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<input ${attrs}>`;
};

const renderTextarea = (field: Field, value: string): string => {
  const attrs = [
    `id="${field.name}"`,
    `name="${field.name}"`,
    'rows="3"',
    field.required ? "required" : "",
    field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<textarea ${attrs}>${escapeHtml(value)}</textarea>`;
};

const renderFieldControl = (field: Field, value: string): string =>
  field.type === "textarea"
    ? renderTextarea(field, value)
    : renderInput(field, value);

/**
 * Render a single form field
 */
export const renderField = (field: Field, value: string = ""): string => `
  <div class="form-group">
    <label for="${field.name}">${escapeHtml(field.label)}</label>
    ${renderFieldControl(field, value)}
    ${field.hint ? `<small style="color: #666; display: block; margin-top: 0.25rem;">${escapeHtml(field.hint)}</small>` : ""}
  </div>
`;

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
  error ? `<div class="error">${escapeHtml(error)}</div>` : "";
