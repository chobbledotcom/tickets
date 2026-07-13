/* jscpd:ignore-start */
import { t } from "#i18n";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { SettingsFormDefinition } from "#shared/settings/forms.ts";
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

const copy = (key: string, opts: { html?: true } = {}): JSX.Element | string =>
  opts.html ? <Raw html={t(key)} /> : t(key);

const description = (definition: SettingsFormDefinition): JSX.Element => (
  <p>
    {copy(definition.copy.descriptionKey, {
      ...("descriptionHtml" in definition.copy &&
      definition.copy.descriptionHtml
        ? { html: true }
        : {}),
    })}
  </p>
);

const submitLabel = (definition: SettingsFormDefinition): string =>
  "submitLabelKey" in definition.copy
    ? t(definition.copy.submitLabelKey)
    : t("common.save");

const formSection = (
  definition: SettingsFormDefinition,
  children: Child,
): JSX.Element =>
  settingsSectionWith(
    {
      action: definition.action,
      description: description(definition),
      submitLabel: submitLabel(definition),
      title: t(definition.copy.titleKey),
    },
    children,
  );

const footer = (definition: SettingsFormDefinition): JSX.Element | undefined =>
  "footerKey" in definition.copy ? (
    <p>
      <small>{t(definition.copy.footerKey)}</small>
    </p>
  ) : undefined;

const labelHint = (
  definition: SettingsFormDefinition,
): JSX.Element | undefined =>
  "labelHint" in definition.copy &&
  definition.copy.labelHint === "formatting" ? (
    <p>
      <small>
        <Raw html={formattingHint()} />
      </small>
    </p>
  ) : undefined;

/** The field name and placeholder both the text input and the textarea take,
 *  read from the same definition so the two inputs can never drift apart. */
const nameAndPlaceholder = (
  definition: Extract<SettingsFormDefinition, { kind: "text" | "textarea" }>,
): { name: string; placeholder: string } => ({
  name: definition.fieldName,
  placeholder: t(definition.copy.placeholderKey),
});

const textForm = (
  definition: Extract<SettingsFormDefinition, { kind: "text" }>,
  state: object,
): JSX.Element =>
  formSection(definition, [
    <TextField
      label={t(definition.copy.labelKey)}
      {...nameAndPlaceholder(definition)}
      type={definition.inputType}
      value={stringState(state, definition.stateField)}
    />,
    footer(definition),
  ]);

const textareaForm = (
  definition: Extract<SettingsFormDefinition, { kind: "textarea" }>,
  state: object,
): JSX.Element =>
  formSection(
    definition,
    <label>
      {t(definition.copy.labelKey)}
      {labelHint(definition)}
      <textarea
        {...("markdownPreview" in definition && definition.markdownPreview
          ? { "data-markdown-preview": true }
          : {})}
        maxlength={MAX_TEXTAREA_LENGTH}
        {...nameAndPlaceholder(definition)}
      >
        {stringState(state, definition.stateField)}
      </textarea>
    </label>,
  );

const booleanForm = (
  definition: Extract<SettingsFormDefinition, { kind: "boolean" }>,
  state: object,
): JSX.Element =>
  formSection(
    definition,
    <YesNoRadios
      name={definition.fieldName}
      on={booleanState(state, definition.stateField)}
    />,
  );

export const settingsForm = (
  definition: SettingsFormDefinition,
  state: object,
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
