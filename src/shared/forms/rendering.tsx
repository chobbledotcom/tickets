/* jscpd:ignore-start */
import { isNotNullish, joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  type ChoiceField,
  type Field,
  type InputField,
  requireCheckboxOptions,
  type TextareaField,
} from "#shared/forms/field.ts";
import { getSavedFieldValue } from "#shared/forms/saved-data.ts";
import type { FieldValues } from "#shared/forms/values.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import { commaParts } from "#shared/split.ts";
import { PriceInput } from "#templates/components/price-input.tsx";
/* jscpd:ignore-end */

export type SelectOption = {
  value: string;
  label: string;
  selected?: boolean;
};

export const renderSelectOptions = (options: readonly SelectOption[]): string =>
  options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${
          option.selected ? " selected" : ""
        }>${escapeHtml(option.label)}</option>`,
    )
    .join("");

const renderCheckboxGroup = (
  name: string,
  options: readonly { value: string; label: string }[],
  selectedValues: Set<string>,
): string =>
  `<fieldset class="checkboxes">${options
    .map(
      (option) =>
        `<label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(
          option.value,
        )}"${selectedValues.has(option.value) ? " checked" : ""}> ${escapeHtml(
          option.label,
        )}</label>`,
    )
    .join("")}</fieldset>`;

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

const splitDatetime = (value: string): { date: string; time: string } => {
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

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
        field.options.map((option) => ({
          ...option,
          selected: option.value === value,
        })),
      )}</select>`,
    );
  }
  requireCheckboxOptions(field.label, field.options);
  return rawField(
    renderCheckboxGroup(field.name, field.options, new Set(commaParts(value))),
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

const resolveFieldValue = (
  field: Field,
  explicit: string | number | null | undefined,
): string => {
  if (isNotNullish(explicit) && explicit !== "") return String(explicit);
  const saved = getSavedFieldValue(field);
  if (saved !== "") return saved;
  return String(explicit ?? field.defaultValue ?? "");
};

export const renderFields = (
  fields: readonly Field[],
  values: FieldValues = {},
): string =>
  pipe(
    map((field: Field) =>
      renderField(field, resolveFieldValue(field, values[field.name])),
    ),
    joinStrings,
  )(fields.filter((field) => field.visible !== false));
