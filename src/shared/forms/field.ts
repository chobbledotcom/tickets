/** One value offered by a select or checkbox group. */
export interface FieldOption<TValue extends string = string> {
  hint?: string;
  label: string;
  value: TValue;
}

export type ChoiceOptions<TValue extends string = string> = readonly [
  FieldOption<TValue>,
  ...FieldOption<TValue>[],
];

interface ChoiceOptionRule {
  invalid: (value: string) => boolean;
  message: (label: string) => string;
}

const makeRequiredOptions =
  (rule?: ChoiceOptionRule) =>
  <TValue extends string>(
    label: string,
    options: readonly FieldOption<TValue>[],
  ): ChoiceOptions<TValue> => {
    const [first, ...rest] = options;
    if (first === undefined) {
      throw new Error(`${label} must define at least one option`);
    }
    const checked: ChoiceOptions<TValue> = [first, ...rest];
    if (rule?.invalid && checked.some(({ value }) => rule.invalid(value))) {
      throw new Error(rule.message(label));
    }
    return checked;
  };

export const requireChoiceOptions = makeRequiredOptions();
export const requireCheckboxOptions = makeRequiredOptions({
  invalid: (value) =>
    value !== value.trim() || value === "" || value.includes(","),
  message: (label) =>
    `${label} checkbox option values must be trimmed, non-empty, and contain no commas`,
});

export type FieldType =
  | InputFieldType
  | "textarea"
  | "select"
  | "checkbox-group"
  | "file";

export type InputFieldType =
  | "text"
  | "number"
  | "email"
  | "url"
  | "password"
  | "date"
  | "datetime"
  | "datetime-local"
  | "hidden"
  | "money";

interface FieldBase<
  TType extends FieldType,
  TName extends string,
  TSection extends string,
> {
  accept?: never;
  autocomplete?: string;
  autofocus?: boolean;
  /** Trusted template HTML rendered immediately before the field's label. */
  beforeHtml?: string;
  defaultValue?: string;
  hint?: string;
  hintHtml?: string;
  id?: string;
  inputmode?: string;
  invalidMessage?: string;
  label: string;
  markdown?: never;
  max?: number;
  maxlength?: number;
  min?: number;
  minlength?: number;
  name: TName;
  options?: never;
  parse?: (value: string) => string | number | null;
  pattern?: string;
  placeholder?: string;
  publicLinkPath?: (value: string) => string;
  required?: boolean;
  requiredMessage?: string;
  section?: TSection;
  title?: string;
  type: TType;
  validate?: (value: string) => string | null;
  /** Excludes the field from rendering without removing it from validation. */
  visible?: boolean;
}

export type InputField<
  TName extends string = string,
  TSection extends string = string,
> = FieldBase<InputFieldType, TName, TSection>;

type FieldWithProperties<
  TType extends FieldType,
  TName extends string = string,
  TSection extends string = string,
  TProperties extends object = object,
> = Omit<FieldBase<TType, TName, TSection>, keyof TProperties> & TProperties;

export type TextareaField<
  TName extends string = string,
  TSection extends string = string,
> = FieldWithProperties<
  "textarea",
  TName,
  TSection,
  {
    /** Marks this as markdown-authored, enabling the in-editor preview link. */
    markdown?: boolean;
  }
>;

export type ChoiceField<
  TType extends "select" | "checkbox-group",
  TValue extends string = string,
  TName extends string = string,
  TSection extends string = string,
> = FieldWithProperties<
  TType,
  TName,
  TSection,
  { options: ChoiceOptions<TValue>; parse?: never }
>;

export type FileField<
  TName extends string = string,
  TSection extends string = string,
> = FieldWithProperties<
  "file",
  TName,
  TSection,
  {
    accept?: string;
    defaultValue?: never;
    parse?: never;
    validate?: never;
  }
>;

/** A field's `type` controls exactly which properties it may carry. */
export type Field<
  TName extends string = string,
  TSection extends string = string,
> =
  | InputField<TName, TSection>
  | TextareaField<TName, TSection>
  | ChoiceField<"select", string, TName, TSection>
  | ChoiceField<"checkbox-group", string, TName, TSection>
  | FileField<TName, TSection>;
