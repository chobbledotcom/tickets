/**
 * Minimal form framework for declarative form handling
 */

import { joinStrings, map, pipe } from "#fp";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  consumeFlash,
  flashConsumed,
  getFlash,
  getFlashFormId,
} from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { appendIframeParam } from "#shared/iframe.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { createRequestScoped } from "#shared/request-scoped.ts";
import { Icon } from "#templates/components/actions.tsx";

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
  accept?: string;
  autocomplete?: string;
  autofocus?: boolean;
  defaultValue?: string;
  hint?: string;
  hintHtml?: string;
  id?: string;
  inputmode?: string;
  label: string;
  /** Marks a textarea as markdown-authored, enabling the in-editor preview link. */
  markdown?: boolean;
  max?: number;
  maxlength?: number;
  min?: number;
  minlength?: number;
  name: string;
  options?: readonly { value: string; label: string }[];
  parse?: (value: string) => string | number | null;
  pattern?: string;
  placeholder?: string;
  required?: boolean;
  title?: string;
  type: FieldType;
  validate?: (value: string) => string | null;
}

type FormFieldDefinition = Readonly<Field>;
type FormFieldDefinitions = readonly FormFieldDefinition[];

type ParsedFieldValue<F extends FormFieldDefinition> = F extends {
  parse: (...args: never[]) => infer T;
}
  ? T
  : F["type"] extends "number"
    ? number | null
    : string | null;

type NormalizedFieldValue<F extends FormFieldDefinition> = F extends {
  required: true;
}
  ? Exclude<ParsedFieldValue<F>, null>
  : ParsedFieldValue<F>;

export type FormValuesFor<TFields extends FormFieldDefinitions> = {
  [F in TFields[number] as F["name"]]: NormalizedFieldValue<F>;
};

type FormFieldRenderHelper = { render: (value?: string) => string };

export type FormDefinition<
  TFields extends FormFieldDefinitions,
  TContext = undefined,
> = {
  id: string;
  fields: TFields;
  render: (values?: Partial<FormValuesFor<TFields>>) => string;
  renderFields: (values?: Partial<FormValuesFor<TFields>>) => string;
  field: (name: TFields[number]["name"]) => FormFieldRenderHelper;
  validate: (
    form: FormParams,
    context?: TContext,
  ) => ValidationResult<FormValuesFor<TFields>>;
};

export interface FieldValues {
  [key: string]: string | number | null;
}

export type ValidationResult<T = FieldValues> =
  | { valid: true; values: T }
  | { valid: false; error: string };

type FieldValidationResult =
  | { valid: true; value: string | number | null }
  | { valid: false; error: string };

/** Render select options HTML */
const renderSelectOptions = (
  options: readonly { value: string; label: string }[],
  selectedValue: string,
): string =>
  options
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.value)}"${
          opt.value === selectedValue ? " selected" : ""
        }>${escapeHtml(opt.label)}</option>`,
    )
    .join("");

/** Render checkbox group HTML (multiple checkboxes with the same name) */
const renderCheckboxGroup = (
  name: string,
  options: readonly { value: string; label: string }[],
  selectedValues: Set<string>,
): string =>
  `<fieldset class="checkboxes">${options
    .map(
      (opt) =>
        `<label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(
          opt.value,
        )}"${selectedValues.has(opt.value) ? " checked" : ""}> ${escapeHtml(
          opt.label,
        )}</label>`,
    )
    .join("")}</fieldset>`;

/** Render split date and time inputs for a datetime field */
const renderDatetimeInputs = (
  name: string,
  { date, time }: { date: string; time: string },
): string =>
  `<input type="date" name="${escapeHtml(
    name,
  )}_date" placeholder="Date" aria-label="Date"${
    date ? ` value="${escapeHtml(date)}"` : ""
  }>` +
  `<input type="time" name="${escapeHtml(
    name,
  )}_time" placeholder="Time" aria-label="Time"${
    time ? ` value="${escapeHtml(time)}"` : ""
  }>`;

const DATETIME_PARTIAL_ERROR =
  "Please enter a date when providing a time, or leave both blank";

/** Combine date and time form values into a datetime string, defaulting time when absent */
const getDatetimeValue = (form: FormParams, name: string): string | null => {
  const date = form.getString(`${name}_date`);
  const time = form.getString(`${name}_time`);
  if (date && time) return `${date}T${time}`;
  if (date && !time) return `${date}T00:00`;
  if (!date && !time) return "";
  return null;
};

/** Split a datetime value (YYYY-MM-DDTHH:MM) into date and time parts */
const splitDatetime = (value: string): { date: string; time: string } => {
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

/** Render the input element for a field based on its type */
const renderFieldInput = (field: Field, value: string): JSX.Element => {
  if (field.type === "textarea") {
    return (
      <textarea
        autocomplete={field.autocomplete}
        data-markdown-preview={field.markdown || undefined}
        id={field.id}
        maxlength={field.maxlength}
        name={field.name}
        placeholder={field.placeholder}
        required={field.required}
      >
        <Raw html={escapeHtml(value)} />
      </textarea>
    );
  }
  if (field.type === "select" && field.options) {
    return (
      <Raw
        html={`<select name="${escapeHtml(field.name)}" id="${escapeHtml(
          field.id ?? field.name,
        )}">${renderSelectOptions(field.options, value)}</select>`}
      />
    );
  }
  if (field.type === "checkbox-group" && field.options) {
    return (
      <Raw
        html={renderCheckboxGroup(
          field.name,
          field.options,
          new Set(value ? value.split(",").map((v) => v.trim()) : []),
        )}
      />
    );
  }
  if (field.type === "datetime") {
    return (
      <Raw html={renderDatetimeInputs(field.name, splitDatetime(value))} />
    );
  }
  if (field.type === "file") {
    return <input accept={field.accept} name={field.name} type="file" />;
  }
  return (
    <input
      autocomplete={field.autocomplete}
      autofocus={field.autofocus}
      id={field.id}
      inputmode={field.inputmode}
      max={field.max}
      maxlength={field.maxlength}
      min={field.min}
      minlength={field.minlength}
      name={field.name}
      pattern={field.pattern}
      placeholder={field.placeholder}
      required={field.required}
      title={field.title}
      type={field.type}
      value={value || undefined}
    />
  );
};

export const renderField = (field: Field, value: string = ""): string =>
  String(
    <label>
      {field.label}
      {renderFieldInput(field, value)}
      {field.hint && <small>{field.hint}</small>}
      {field.hintHtml && (
        <small>
          <Raw html={field.hintHtml} />
        </small>
      )}
    </label>,
  );

/**
 * Resolve the value to render for a single field.
 *
 * Precedence:
 *   1. A non-empty caller-supplied value always wins (an entity being edited,
 *      or a value the handler deliberately sets).
 *   2. Otherwise saved form data — captured on CSRF failure or restored from
 *      the re-fill stash after a redirect — is used, so a re-rendered form
 *      shows what the user just typed rather than a blank/missing entity.
 *   3. Otherwise the caller value (possibly empty) or the field's defaultValue.
 *
 * When there is no saved data this is identical to taking the caller value,
 * then the defaultValue — so normal rendering is unaffected.
 */
const resolveFieldValue = (
  field: Field,
  explicit: string | number | null | undefined,
): string => {
  if (explicit != null && explicit !== "") return String(explicit);
  const saved = getSavedValue(field);
  if (saved !== "") return saved;
  return String(explicit ?? field.defaultValue ?? "");
};

/**
 * Render multiple fields with values.
 * Each field's value is resolved via resolveFieldValue, so saved form data
 * (CSRF-failure capture or the post-redirect re-fill stash) automatically
 * restores user input without any changes to individual handlers or templates.
 */
export const renderFields = (
  fields: Field[],
  values: FieldValues = {},
): string =>
  pipe(
    map((f: Field) => renderField(f, resolveFieldValue(f, values[f.name]))),
    joinStrings,
  )(fields);

export const booleanToCheckbox = (value: boolean): string => (value ? "1" : "");

export const entityToFieldValues = <T,>(
  entity: T | undefined,
  fields: Field[],
  formatters: Partial<Record<keyof T, (e: T) => string | number | null>>,
  extra?: Record<string, string | number | null>,
): FieldValues => {
  const values: FieldValues = {};
  for (const f of fields) {
    const formatter = formatters[f.name as keyof T];
    values[f.name] =
      entity && formatter
        ? formatter(entity)
        : entity
          ? String((entity as unknown as Record<string, unknown>)[f.name])
          : "";
  }
  if (extra) Object.assign(values, extra);
  return values;
};

/**
 * Parse field value to the appropriate type.
 * Empty strings stay as "" for text fields; empty numbers become null.
 */
const parseFieldValue = (
  field: Field,
  trimmed: string,
): string | number | null =>
  field.parse
    ? field.parse(trimmed)
    : field.type === "number"
      ? trimmed
        ? Number.parseInt(trimmed, 10)
        : null
      : trimmed;

/**
 * Collect the raw trimmed value for a field from the form data.
 * Returns the string value, or a FieldValidationResult for early exit
 * (e.g. datetime partial error or empty-but-not-required datetime).
 */
const collectFieldValue = (
  form: FormParams,
  field: Field,
): string | FieldValidationResult => {
  if (field.type === "datetime") {
    const result = getDatetimeValue(form, field.name);
    if (result === null) return { error: DATETIME_PARTIAL_ERROR, valid: false };
    if (!result) {
      if (field.required) {
        return { error: `${field.label} is required`, valid: false };
      }
      return { valid: true, value: null };
    }
    return result;
  }
  if (field.type === "checkbox-group") {
    return form
      .getAll(field.name)
      .map((v) => v.trim())
      .filter((v) => v)
      .join(",");
  }
  return form.getString(field.name);
};

/**
 * Validate a single field and return its parsed value.
 * For checkbox-group fields, collects all checked values via getAll()
 * and joins them as a comma-separated string.
 */
const validateSingleField = (
  form: FormParams,
  field: Field,
): FieldValidationResult => {
  // File fields are handled separately via FormData, not URLSearchParams
  if (field.type === "file") return { valid: true, value: null };

  const collected = collectFieldValue(form, field);
  if (typeof collected !== "string") return collected;

  let trimmed = collected;

  if (!trimmed && field.defaultValue) {
    trimmed = field.defaultValue;
  }

  if (field.required && !trimmed) {
    return { error: `${field.label} is required`, valid: false };
  }

  if (field.validate && trimmed) {
    const error = field.validate(trimmed);
    if (error) return { error, valid: false };
  }

  // Enforce the field's maxlength server-side (the rendered input's maxlength is
  // only a browser hint). Runs after any custom validator so a field with its
  // own length rule keeps its domain-specific message.
  if (field.maxlength && trimmed.length > field.maxlength) {
    return {
      error: `${field.label} must be ${field.maxlength} characters or fewer`,
      valid: false,
    };
  }

  return { valid: true, value: parseFieldValue(field, trimmed) };
};

/**
 * Parse and validate form data against field definitions.
 *
 * Supply a type parameter to get strongly-typed values back:
 *   validateForm<ListingFormValues>(form, getListingFields())
 *
 * Without a type parameter, values default to the loose FieldValues dict.
 */
export const validateForm = <T = FieldValues>(
  form: FormParams,
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

const normalizeOptionalValue = (
  field: Field,
  value: string | number | null,
): string | number | null => {
  if (field.required) return value;
  if (field.type === "number") return value;
  return value === "" ? null : value;
};

/**
 * Define a typed form schema that can render and validate from one source.
 */
export const defineForm = <
  TFields extends FormFieldDefinitions,
  TContext = undefined,
>(config: {
  id: string;
  fields: TFields;
  validate?: (
    values: FormValuesFor<TFields>,
    context: TContext,
  ) => string | null;
}): FormDefinition<TFields, TContext> => {
  const fields = [...config.fields];
  const fieldMap = new Map(fields.map((f) => [f.name, f] as const));

  const validate = (
    form: FormParams,
    context?: TContext,
  ): ValidationResult<FormValuesFor<TFields>> => {
    const base = validateForm<Record<string, string | number | null>>(
      form,
      fields,
    );
    if (!base.valid) return base;

    const values = Object.fromEntries(
      fields.map((field) => [
        field.name,
        normalizeOptionalValue(field, base.values[field.name] ?? null),
      ]),
    ) as FormValuesFor<TFields>;

    if (config.validate) {
      const error = config.validate(values, context as TContext);
      if (error) return { error, valid: false };
    }
    return { valid: true, values };
  };

  const render = (values: Partial<FormValuesFor<TFields>> = {}): string =>
    renderFields(fields, values as FieldValues);

  return {
    field: (name) => ({
      render: (value = "") => renderField(fieldMap.get(name)!, value),
    }),
    fields: config.fields,
    id: config.id,
    render,
    renderFields: render,
    validate,
  };
};

/**
 * Flash message component for error/success notifications.
 * Renders divs with role="alert" so screen readers announce them.
 *
 * Rendering any banner marks the request's flash as consumed, so the Layout
 * backstop (which renders the context flash on every page) won't render it a
 * second time. This is what lets a page render its flash inline — or not at all
 * — without ever double-rendering or dropping it.
 */
export const Flash = ({
  error,
  success,
  info,
}: {
  error?: string | undefined;
  success?: string | undefined;
  info?: string | undefined;
}): JSX.Element => {
  if (error || success || info) consumeFlash();
  return (
    <>
      {success ? (
        <div class="success" role="alert">
          {success}
        </div>
      ) : null}
      {info ? (
        <div class="info" role="alert">
          {info}
        </div>
      ) : null}
      {error ? (
        <div class="error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
};

/**
 * Render error message if present
 */
export const renderError = (error?: string): string =>
  error ? String(<Flash error={error} />) : "";

/**
 * Render success message if present
 */
export const renderSuccess = (message?: string): string =>
  message ? String(<Flash success={message} />) : "";

/** Field types that must never be restored from saved form data */
const SENSITIVE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  "password",
  "file",
]);

/**
 * Per-request saved form data, set when CSRF validation fails.
 * Allows renderField/renderFields to restore user input automatically
 * without any changes to individual form handlers or templates.
 * Only non-sensitive field types (not password/file) are restored.
 */
const savedFormScope = createRequestScoped<{ form: FormParams | null }>(() => ({
  form: null,
}));

/** Run a function within a saved-form-data scope (one container per request) */
export const runWithSavedFormContext = <T,>(fn: () => T): T =>
  savedFormScope.run(fn);

/** Save form data for restoration after CSRF failure */
export const setSavedFormData = (form: FormParams): void => {
  savedFormScope.current().form = form;
};

/** Clear saved form data (called on successful CSRF validation) */
export const clearSavedFormData = (): void => {
  savedFormScope.current().form = null;
};

/**
 * Get the current request's saved form data, or null when none was captured.
 * Used by `redirect()` to stash a failed submission for re-filling after the
 * follow-up GET.
 */
export const getSavedFormData = (): FormParams | null =>
  savedFormScope.current().form;

/**
 * Read a raw saved form value by name, or "" when nothing was restored. Lets the
 * non-Field booking controls (quantity selectors, the date and day-count
 * pickers, question radios, the terms checkbox) re-fill from the form-stash
 * after a failed booking redirect, alongside renderFields for the normal inputs.
 */
export const savedFormValue = (name: string): string =>
  savedFormScope.current().form?.getString(name) ?? "";

/** Get a saved value for a field, or empty string if not available */
const getSavedValue = (field: Field): string => {
  const form = savedFormScope.current().form;
  if (!form || SENSITIVE_FIELD_TYPES.has(field.type)) return "";
  if (field.type === "checkbox-group") {
    return form
      .getAll(field.name)
      .map((v) => v.trim())
      .filter((v) => v)
      .join(",");
  }
  if (field.type === "datetime") {
    const date = form.getString(`${field.name}_date`);
    const time = form.getString(`${field.name}_time`);
    if (date && time) return `${date}T${time}`;
    if (date) return `${date}T00:00`;
    return "";
  }
  return form.getString(field.name);
};

/**
 * Form component that always includes CSRF token.
 * Renders a POST form with a hidden csrf_token input.
 * Reads the token from the module-scoped store set by signCsrfToken(),
 * which is always called before rendering begins.
 * Supports extra attributes like class and enctype for multipart forms.
 * When `id` is provided, the form gets an id attribute (also usable as an anchor).
 *
 * When a redirect targeted this form (its `id` matches the flash's `?form=`),
 * the form renders the flash inline — keeping the message next to the form that
 * was submitted on multi-form pages — and marks it consumed so the Layout
 * backstop doesn't also render it at the top.
 */
export const CsrfForm = ({
  action,
  children,
  ...rest
}: {
  action: string;
  children?: Child;
  id?: string | undefined;
  class?: string;
  enctype?: string;
} & { [key: `data-${string}`]: string | boolean }): JSX.Element => (
  // autocomplete="off" stops the browser's own form cache from overwriting the
  // values we restore from the re-fill stash. Fields that want native autofill
  // (name, email, tel, …) set their own autocomplete and override this default.
  <form
    action={appendIframeParam(action)}
    autocomplete="off"
    method="POST"
    {...rest}
  >
    <input name="csrf_token" type="hidden" value={getCurrentCsrfToken()} />
    {rest.id && rest.id === getFlashFormId() && !flashConsumed() && (
      <Flash error={getFlash().error} success={getFlash().success} />
    )}
    {children}
  </form>
);

/**
 * The message textarea and submit button shared by the public contact form and
 * the admin support form. Each form supplies its own surrounding <form> and
 * heading; the contact form adds its own email input above this. Any `children`
 * render between the textarea and the submit button (e.g. the support form's
 * repeat-submit notice).
 */
export const MessageFields = ({
  children,
}: {
  children?: Child;
}): JSX.Element => (
  <>
    <label>
      Message
      <textarea
        maxlength={MAX_TEXTAREA_LENGTH}
        name="message"
        required
      ></textarea>
    </label>
    {children}
    <button type="submit">Send message</button>
  </>
);

/**
 * Confirmation form with identifier verification.
 * Wraps a CsrfForm with a confirm_identifier input and submit button.
 * Children are rendered above the prompt as warning/detail content.
 *
 *   <ConfirmForm
 *     action={`/admin/listing/${id}/delete`}
 *     name={listing.name}
 *     label="Listing name"
 *     buttonText="Delete Listing"
 *   >
 *     <p><strong>Warning:</strong> This will permanently delete the listing.</p>
 *     <p>To delete this listing, type its name "{listing.name}" into the box below:</p>
 *   </ConfirmForm>
 *
 * Pass `confirmName={false}` for an are-you-sure page that does NOT require
 * the operator to retype the entity's name (e.g. deleting a note whose body
 * is shown inline on the confirmation page). The `name`/`label` props become
 * optional in that mode; the type-the-name input is omitted entirely.
 */
export const ConfirmForm = ({
  action,
  name,
  label,
  buttonText,
  danger = true,
  returnUrl,
  id,
  hiddenFields,
  confirmName = true,
  children,
}: {
  action: string;
  name?: string;
  label?: string;
  buttonText: string;
  danger?: boolean;
  returnUrl?: string | undefined;
  id?: string;
  hiddenFields?: Record<string, string>;
  /** When false, omit the type-the-name input — a plain are-you-sure page. */
  confirmName?: boolean;
  children?: Child;
}): JSX.Element => (
  <CsrfForm action={action} id={id}>
    {children && <div class="prose">{children}</div>}
    {returnUrl && <input name="return_url" type="hidden" value={returnUrl} />}
    {hiddenFields &&
      Object.entries(hiddenFields).map(([fieldName, value]) => (
        <input name={fieldName} type="hidden" value={value} />
      ))}
    {confirmName && (
      <label>
        {label}
        <input
          autocomplete="off"
          name="confirm_identifier"
          placeholder={name}
          required
          type="text"
        />
      </label>
    )}
    <button class={danger ? "danger" : undefined} type="submit">
      <Icon name={danger ? "trash-2" : "check"} />
      <span>{buttonText}</span>
    </button>
  </CsrfForm>
);
