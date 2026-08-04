/**
 * The shapes a settings form definition can take. The registry in
 * `forms.ts` declares the forms; the renderer in
 * `src/ui/templates/admin/settings/schema-form.tsx` turns them into markup.
 */

import type { ChoiceOption } from "#shared/choice.ts";
import type { ConfigKey } from "#shared/settings/keys.ts";

export type SettingsFormPage = "main" | "advanced";

export type FormCopyBase = {
  titleKey: string;
  descriptionKey: string;
  /** `true` renders the trusted-HTML description inside the usual paragraph;
   * `"block"` renders it bare, for catalog values carrying their own block
   * markup (their own `<p>` tags). */
  descriptionHtml?: true | "block";
};

export type FieldFormCopy = FormCopyBase & {
  labelKey: string;
  labelHint?: "formatting";
  /** Placeholder: a catalog key, or text built at render time (for example a
   * default template). Set at most one; omit both for no placeholder. */
  placeholderKey?: string;
  placeholderText?: () => string;
  submitLabelKey: string;
  /** Small note under the field: a catalog key, or text built at render time. */
  footerKey?: string;
  footerText?: () => string;
};

type BooleanFormCopy = FormCopyBase;

/** What every settings form declares, whatever its shape: where it lives,
 *  where it posts, and its heading copy. */
type SettingsFormIdentity<Copy extends FormCopyBase> = {
  name: string;
  page: SettingsFormPage;
  action: string;
  formId: string;
  routeLabel: string;
  copy: Copy;
};

/** A form that edits exactly one setting through one form field. */
type SettingsFormBase<Copy extends FormCopyBase> =
  SettingsFormIdentity<Copy> & {
    key: ConfigKey;
    fieldName: string;
    stateField: string;
  };

export type TextSettingsFormConfig = SettingsFormBase<FieldFormCopy> & {
  kind: "text";
  inputType: "email" | "text" | "number" | "url";
  /** Input constraints, forwarded to the rendered field as-is. */
  min?: string;
  max?: string;
  step?: string;
  minlength?: number;
  required?: true;
  /** Show the placeholder as the value when nothing is saved yet. */
  valueFallback?: "placeholder";
};

export type TextareaSettingsFormConfig = SettingsFormBase<FieldFormCopy> & {
  kind: "textarea";
  markdownPreview?: true;
};

export type BooleanSettingsFormConfig = SettingsFormBase<BooleanFormCopy> & {
  kind: "boolean";
};

/** One field inside a multi-field form. */
type FieldSpecBase = {
  fieldName: string;
  stateField: string;
};

/** One choice in a radio group or dropdown: the value it posts and the
 *  catalog key naming it. */

/** A choice whose label is already final text, built at render time. */
type ResolvedChoice = { value: string; label: string };

/** A radio group: one option per choice, no heading of its own. */
export type RadiosFieldSpec = FieldSpecBase & {
  kind: "radios";
  options: readonly ChoiceOption[];
};

/** A checkbox that posts `true` when ticked. */
export type CheckboxFieldSpec = FieldSpecBase & {
  kind: "checkbox";
  labelKey: string;
  /** Class for the wrapping label (omitted for an unstyled label). */
  labelClass?: string;
  /** Small plain note rendered after the checkbox. */
  hintKey?: string;
};

/** A dropdown. With `labelFor`, the label sits before the select and points
 *  at it by id; without, the label wraps the select. */
export type SelectFieldSpec = FieldSpecBase & {
  kind: "select";
  labelKey: string;
  labelFor?: true;
  /** Fixed choices, or a build function for labels only known at render
   *  time (e.g. provider brand names). */
  options: readonly ChoiceOption[] | (() => readonly ResolvedChoice[]);
};

/** A stored secret edited through a masked password input. */
export type SecretFieldSpec = {
  kind: "secret";
  fieldName: string;
  labelKey: string;
  placeholderKey: string;
  /** Page-state flag saying whether a secret is already stored. */
  configuredStateField: string;
};

export type FieldSpec =
  | CheckboxFieldSpec
  | RadiosFieldSpec
  | SecretFieldSpec
  | SelectFieldSpec;

/** A form of several fields saved together by one hand-written route. */
export type FieldsSettingsFormConfig = SettingsFormIdentity<
  FormCopyBase & { submitLabelKey: string }
> & {
  kind: "fields";
  fields: readonly FieldSpec[];
};

export type SettingsFormConfig =
  | BooleanSettingsFormConfig
  | FieldsSettingsFormConfig
  | TextSettingsFormConfig
  | TextareaSettingsFormConfig;
