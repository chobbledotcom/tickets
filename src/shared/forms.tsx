/**
 * Minimal form framework for declarative form handling
 */

import * as v from "valibot";
/* jscpd:ignore-start */
import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  consumeFlash,
  flashConsumed,
  getFlash,
  getFlashFormId,
} from "#shared/flash-context.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  type ChoiceField,
  type Field,
  type FieldType,
  type InputField,
  requireCheckboxOptions,
  type TextareaField,
} from "#shared/forms/field.ts";
import { appendIframeParam } from "#shared/iframe.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { createRequestScoped } from "#shared/request-scoped.ts";
import { ErrorAlert } from "#templates/components/error.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";

/* jscpd:ignore-end */

export type {
  ChoiceField,
  ChoiceOptions,
  Field,
  FieldOption,
  FieldType,
  FileField,
  InputField,
  TextareaField,
} from "#shared/forms/field.ts";
export {
  requireCheckboxOptions,
  requireChoiceOptions,
} from "#shared/forms/field.ts";

export interface FieldValues {
  [key: string]: string | number | null;
}

export type FieldValueNormalizer = (
  field: Field,
  value: string | number | null,
) => string | number | null;

export type ValidationResult<T = FieldValues> =
  | { valid: true; values: T }
  | { valid: false; error: string };

type FieldValidationResult =
  | { valid: true; value: string | number | null }
  | { valid: false; error: string };

/** One entry in a select's option list. */
export type SelectOption = {
  value: string;
  label: string;
  /** Marks this entry as the chosen one. */
  selected?: boolean;
};

/** Render a select's option list, escaping every value and label. The one
 * builder behind every dropdown — booking-page selectors, admin filters, and
 * the form framework's own select fields all share it. */
export const renderSelectOptions = (options: readonly SelectOption[]): string =>
  options
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.value)}"${
          opt.selected ? " selected" : ""
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

/** Parse a checkbox-group field's values from a form: collect all checked
 *  values via getAll(), trim, drop empties, join as comma-separated. */
const parseCheckboxGroup = (form: FormParams, name: string): string =>
  form
    .getAll(name)
    .map((v) => v.trim())
    .filter((v) => v)
    .join(",");

/** Read a field's raw submitted text from the form, by field type: a
 *  checkbox group joins its ticked boxes into one comma-separated string, a
 *  datetime joins its date and time inputs (null when only a time was given),
 *  and every other type reads its single input. Shared by validation and by
 *  the saved-form re-fill, so the two can never read a field differently. */
const readFieldText = (form: FormParams, field: Field): string | null => {
  if (field.type === "checkbox-group") {
    return parseCheckboxGroup(form, field.name);
  }
  if (field.type === "datetime") {
    return getDatetimeValue(form, field.name);
  }
  return form.getString(field.name);
};

/** Split a datetime value (YYYY-MM-DDTHH:MM) into date and time parts */
const splitDatetime = (value: string): { date: string; time: string } => {
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

/** Render an arbitrary HTML string as a JSX element — the per-field renderers
 *  that build raw HTML (selects, checkbox groups) wrap their output in this so
 *  the `<Raw html={...}/>` shape lives in one place. */
const rawField = (html: string): JSX.Element => <Raw html={html} />;

const renderTextareaInput = (
  field: TextareaField,
  value: string,
): JSX.Element => (
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

const renderChoiceFieldInput = (
  field: ChoiceField<"select" | "checkbox-group">,
  value: string,
): JSX.Element => {
  if (field.type === "select") {
    return rawField(
      `<select name="${escapeHtml(field.name)}" id="${escapeHtml(
        field.id ?? field.name,
      )}"${field.required ? " required" : ""}>${renderSelectOptions(
        field.options.map((opt) => ({ ...opt, selected: opt.value === value })),
      )}</select>`,
    );
  }
  requireCheckboxOptions(field.label, field.options);
  return rawField(
    renderCheckboxGroup(
      field.name,
      field.options,
      new Set(value ? value.split(",").map((v) => v.trim()) : []),
    ),
  );
};

const renderSpecialFieldInput = (
  field: InputField,
  value: string,
): JSX.Element | null => {
  if (field.type === "datetime") {
    return (
      <Raw html={renderDatetimeInputs(field.name, splitDatetime(value))} />
    );
  }
  if (field.type === "money") {
    return PriceInput({
      name: field.name,
      ...(field.id ? { id: field.id } : {}),
      ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.required ? { required: true } : {}),
      ...(value ? { value } : {}),
    });
  }
  return null;
};

/** Render the input element for a field based on its type */
const renderFieldInput = (field: Field, value: string): JSX.Element => {
  if (field.type === "textarea") return renderTextareaInput(field, value);
  if (field.type === "select" || field.type === "checkbox-group") {
    return renderChoiceFieldInput(field, value);
  }
  if (field.type === "file") {
    return (
      <input
        accept={field.accept}
        id={field.id}
        name={field.name}
        required={field.required}
        type="file"
      />
    );
  }
  const special = renderSpecialFieldInput(field, value);
  if (special) return special;
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

const selectOptionHints = (field: Field): JSX.Element | null => {
  if (field.type !== "select" || !field.options.some((option) => option.hint)) {
    return null;
  }
  return (
    <ul>
      {field.options.map((option) =>
        option.hint ? (
          <li>
            <strong>{option.label}:</strong> {option.hint}
          </li>
        ) : null,
      )}
    </ul>
  );
};

/** The "Public link: <path>" line under a slug-style field: rendered only when
 *  the field opts in via {@link Field.publicLinkPath} and has a value, so a new
 *  (unsaved) entity with no slug shows no link. Opens in a new tab. */
const publicLinkHint = (field: Field, value: string): JSX.Element | null => {
  if (!("publicLinkPath" in field) || !field.publicLinkPath || !value) {
    return null;
  }
  const path = field.publicLinkPath(value);
  return (
    <small class="public-link">
      {t("common.public_link")}:{" "}
      <a href={path} rel="noopener" target="_blank">
        {path}
      </a>
    </small>
  );
};

export const renderField = (field: Field, value: string = ""): string =>
  (field.beforeHtml ?? "") +
  String(
    <>
      <label>
        {field.label}
        {renderFieldInput(field, value)}
        {field.hint && <small>{field.hint}</small>}
        {field.hintHtml && (
          <small>
            <Raw html={field.hintHtml} />
          </small>
        )}
        {publicLinkHint(field, value)}
      </label>
      {selectOptionHints(field)}
    </>,
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
  fields: readonly Field[],
  values: FieldValues = {},
): string =>
  pipe(
    map((f: Field) => renderField(f, resolveFieldValue(f, values[f.name]))),
    joinStrings,
  )(fields.filter((field) => field.visible !== false));

export const booleanToCheckbox = (value: boolean): string => (value ? "1" : "");

export const entityToFieldValues = <T,>(
  entity: T | undefined,
  fields: readonly Field[],
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
        ? Number(trimmed)
        : null
      : trimmed;

const choiceSchema = (
  field: ChoiceField<"select" | "checkbox-group">,
): v.PicklistSchema<readonly [string, ...string[]], undefined> => {
  const [first, ...rest] = field.options;
  return v.picklist([first.value, ...rest.map((option) => option.value)]);
};

const hasInvalidChoice = (
  field: ChoiceField<"select" | "checkbox-group">,
  value: string,
): boolean => {
  const values =
    field.type === "checkbox-group"
      ? value.split(",").map((choice) => choice.trim())
      : [value];
  const schema = choiceSchema(field);
  return values.some((choice) => !v.safeParse(schema, choice).success);
};

const requiredFieldError = (field: Field): FieldValidationResult => ({
  error: field.requiredMessage ?? `${field.label} is required`,
  valid: false,
});

const isUnusableParsedValue = (value: string | number | null): boolean =>
  value === null || (typeof value === "number" && !Number.isFinite(value));

/**
 * Collect the raw trimmed value for a field from the form data.
 * Returns the string value, or a FieldValidationResult for early exit
 * (e.g. datetime partial error or empty-but-not-required datetime).
 */
const collectFieldValue = (
  form: FormParams,
  field: Field,
): string | FieldValidationResult => {
  const raw = readFieldText(form, field);
  // Only a datetime can read as null: a time was given without a date.
  if (raw === null) return { error: DATETIME_PARTIAL_ERROR, valid: false };
  return raw;
};

const validateFieldText = (field: Field, value: string): string | null => {
  if (field.validate && value) {
    const error = field.validate(value);
    if (error) return error;
  }
  if (
    value &&
    (field.type === "select" || field.type === "checkbox-group") &&
    hasInvalidChoice(field, value)
  ) {
    return (
      field.invalidMessage ?? t("error.field_invalid", { label: field.label })
    );
  }
  if (
    "maxlength" in field &&
    field.maxlength !== undefined &&
    value.length > field.maxlength
  ) {
    return `${field.label} must be ${field.maxlength} characters or fewer`;
  }
  return null;
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
    return requiredFieldError(field);
  }

  const textError = validateFieldText(field, trimmed);
  if (textError) return { error: textError, valid: false };

  const value = parseFieldValue(field, trimmed);
  if (trimmed && isUnusableParsedValue(value)) {
    return {
      error:
        field.invalidMessage ??
        t("error.field_invalid", { label: field.label }),
      valid: false,
    };
  }
  return { valid: true, value };
};

/**
 * Parse and validate form data against field definitions.
 *
 * Prefer `defineForm` for typed values derived from the field declaration.
 * Direct callers default to the loose FieldValues dictionary.
 */
export const validateForm = <T = FieldValues>(
  form: FormParams,
  fields: readonly Field[],
  normalizeValue: FieldValueNormalizer = (_field, value) => value,
): ValidationResult<T> => {
  const values: FieldValues = {};

  for (const field of fields) {
    const result = validateSingleField(form, field);
    if (!result.valid) return result;
    values[field.name] = normalizeValue(field, result.value);
  }

  return { valid: true, values: values as T };
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
export const Flash = ({ error, success, info }: FlashFields): JSX.Element => {
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
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </>
  );
};

export const requestFlash = (): JSX.Element | null => {
  const { error, info, success } = getFlash();
  return <Flash error={error} info={info} success={success} />;
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

/** Get a saved value for a field, or empty string if not available. A
 *  half-filled datetime (time without date) reads as null and restores
 *  nothing — there is no valid value to re-fill. */
const getSavedValue = (field: Field): string => {
  const form = savedFormScope.current().form;
  if (!form || SENSITIVE_FIELD_TYPES.has(field.type)) return "";
  return readFieldText(form, field) ?? "";
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
/** Render a `[name, value]` list as hidden `<input>`s — the shared shape used
 *  by ConfirmForm's `hiddenFields` and the bulk-email recipient control. */
export const hiddenInputs = (
  entries: readonly (readonly [string, string])[],
): JSX.Element[] =>
  entries.map(([name, value]) => (
    <input name={name} type="hidden" value={value} />
  ));
