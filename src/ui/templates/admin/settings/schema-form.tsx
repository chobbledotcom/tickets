/* jscpd:ignore-start */
import { t } from "#i18n";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type {
  BooleanSettingsFormConfig,
  FieldFormCopy,
  FormCopyBase,
  SettingsFormDefinition,
  TextareaSettingsFormConfig,
  TextSettingsFormConfig,
} from "#shared/settings/forms.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { settingsSectionWith } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
import { YesNoRadios } from "#templates/components/yes-no-radios.tsx";

/* jscpd:ignore-end */

const stateValue = (state: object, field: string): unknown =>
  (state as Record<string, unknown>)[field];

const stringState = (state: object, field: string): string =>
  String(stateValue(state, field) ?? "");

const booleanState = (state: object, field: string): boolean =>
  stateValue(state, field) === true;

/** Copy that is either a catalog key or text built at render time. */
const resolveCopy = (
  key: string | undefined,
  build: (() => string) | undefined,
): string | undefined => (key !== undefined ? t(key) : build?.());

const description = (copy: FormCopyBase): Child => {
  const body = copy.descriptionHtml ? (
    <Raw html={t(copy.descriptionKey)} />
  ) : (
    t(copy.descriptionKey)
  );
  // "block" copy carries its own block markup, so no paragraph wrapper.
  return copy.descriptionHtml === "block" ? body : <p>{body}</p>;
};

const submitLabel = (copy: { submitLabelKey?: string | undefined }): string =>
  copy.submitLabelKey !== undefined ? t(copy.submitLabelKey) : t("common.save");

const formSection = (
  definition: {
    action: string;
    formId: string;
    copy: FormCopyBase & { submitLabelKey?: string | undefined };
  },
  children: Child,
): JSX.Element =>
  settingsSectionWith(
    {
      action: definition.action,
      description: description(definition.copy),
      id: definition.formId,
      submitLabel: submitLabel(definition.copy),
      title: t(definition.copy.titleKey),
    },
    children,
  );

const footer = (copy: FieldFormCopy): JSX.Element | undefined => {
  const note = resolveCopy(copy.footerKey, copy.footerText);
  return note === undefined ? undefined : (
    <p>
      <small>{note}</small>
    </p>
  );
};

const labelHint = (copy: FieldFormCopy): JSX.Element | undefined =>
  copy.labelHint === "formatting" ? (
    <p>
      <small>
        <Raw html={formattingHint()} />
      </small>
    </p>
  ) : undefined;

const placeholderFor = (copy: FieldFormCopy): string | undefined =>
  resolveCopy(copy.placeholderKey, copy.placeholderText);

/** The saved value; a form with a "placeholder" fallback shows its
 *  placeholder instead when nothing is saved yet. */
const textValue = (
  definition: TextSettingsFormConfig,
  state: object,
): string | undefined => {
  const value = stringState(state, definition.stateField);
  return definition.valueFallback === "placeholder"
    ? value || placeholderFor(definition.copy)
    : value;
};

const textForm = (
  definition: TextSettingsFormConfig,
  state: object,
): JSX.Element =>
  formSection(definition, [
    <TextField
      label={t(definition.copy.labelKey)}
      max={definition.max}
      min={definition.min}
      minlength={definition.minlength}
      name={definition.fieldName}
      placeholder={placeholderFor(definition.copy)}
      required={definition.required}
      step={definition.step}
      type={definition.inputType}
      value={textValue(definition, state)}
    />,
    footer(definition.copy),
  ]);

const textareaForm = (
  definition: TextareaSettingsFormConfig,
  state: object,
): JSX.Element =>
  formSection(
    definition,
    <label>
      {t(definition.copy.labelKey)}
      {labelHint(definition.copy)}
      <textarea
        data-markdown-preview={definition.markdownPreview}
        maxlength={MAX_TEXTAREA_LENGTH}
        name={definition.fieldName}
        placeholder={placeholderFor(definition.copy)}
      >
        {stringState(state, definition.stateField)}
      </textarea>
    </label>,
  );

const booleanForm = (
  definition: BooleanSettingsFormConfig,
  state: object,
): JSX.Element =>
  formSection(
    definition,
    <YesNoRadios
      name={definition.fieldName}
      on={booleanState(state, definition.stateField)}
    />,
  );

/** Render a settings form from its registry definition. The definition's
 * `stateField` must be a real field of the page state handed in, so a typo'd
 * or misplaced definition fails to compile instead of rendering blank. */
export const settingsForm = <S extends object>(
  definition: Extract<SettingsFormDefinition, { stateField: keyof S & string }>,
  state: S,
): JSX.Element => {
  switch (definition.kind) {
    case "boolean":
      return booleanForm(definition, state);
    case "text":
      return textForm(definition, state);
    case "textarea":
      return textareaForm(definition, state);
  }
};
