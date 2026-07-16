import type { FormParams } from "#shared/form-data.ts";
import {
  type Field,
  type FieldValueNormalizer,
  type FieldValues,
  renderField,
  renderFields,
  requireChoiceOptions,
  type ValidationResult,
  validateForm,
} from "#shared/forms.tsx";

export type FormFieldDefinition = Readonly<Field>;
export type FormFieldDefinitions = readonly FormFieldDefinition[];

export type FormRenderValuesFor<TFields extends FormFieldDefinitions> = Partial<
  Record<TFields[number]["name"], string | number | null>
>;

type SelectOptionValue<F extends FormFieldDefinition> = F extends {
  type: "select";
  options: readonly { value: infer TValue extends string }[];
}
  ? Exclude<TValue, "">
  : never;

type ParsedFieldValue<F extends FormFieldDefinition> = F extends {
  parse: (...args: never[]) => infer T;
}
  ? T
  : F["type"] extends "select"
    ? SelectOptionValue<F> | null
    : F["type"] extends "number"
      ? number | null
      : F["type"] extends "file"
        ? null
        : string;

type NormalizedFieldValue<F extends FormFieldDefinition> = F extends {
  required: true;
}
  ? Exclude<ParsedFieldValue<F>, null>
  : F extends { defaultValue: string }
    ? Exclude<ParsedFieldValue<F>, null>
    : ParsedFieldValue<F>;

export type FormValuesFor<TFields extends FormFieldDefinitions> = {
  [F in TFields[number] as F["name"]]: NormalizedFieldValue<F>;
};

export type FormValues<TForm> =
  TForm extends FormDefinition<infer TFields, infer _TContext>
    ? FormValuesFor<TFields>
    : never;

type FormFieldRenderHelper = {
  render: (value?: string) => string;
};

type FormSectionId<TFields extends FormFieldDefinitions> =
  TFields[number] extends infer TField
    ? TField extends { section: infer TSection extends string }
      ? TSection
      : never
    : never;

export interface FormSchema<TValues> {
  fields: readonly Field[];
  validate: (form: FormParams) => ValidationResult<TValues>;
}

export type FormDefinition<
  TFields extends FormFieldDefinitions,
  TContext = undefined,
> = {
  id: string;
  fields: TFields;
  render: (values?: FormRenderValuesFor<TFields>) => string;
  renderFields: (values?: FormRenderValuesFor<TFields>) => string;
  field: (name: TFields[number]["name"]) => FormFieldRenderHelper;
  section: (
    id: FormSectionId<TFields>,
    values?: FormRenderValuesFor<TFields>,
  ) => string;
  sections: readonly FormSectionId<TFields>[];
  validate: (
    form: FormParams,
    context?: TContext,
  ) => ValidationResult<FormValuesFor<TFields>>;
};

const normalizeSelectValue: FieldValueNormalizer = (
  field: Field,
  value: string | number | null,
) => (field.type === "select" && value === "" ? null : value);

/** Define a typed form schema that can render and validate from one source. */
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
  const fields = config.fields.map((field) => {
    if (field.type === "select" || field.type === "checkbox-group") {
      requireChoiceOptions(field.label, field.options);
    }
    return field;
  });
  const fieldMap = new Map(fields.map((field) => [field.name, field] as const));
  const sectionIds = [
    ...new Set(
      fields.flatMap((field) =>
        field.section === undefined ? [] : [field.section],
      ),
    ),
  ] as FormSectionId<TFields>[];

  const fieldByName = (name: TFields[number]["name"]): Field => {
    const field = fieldMap.get(name);
    if (!field) throw new Error(`Unknown field: ${name}`);
    return field;
  };

  const validate = (
    form: FormParams,
    context?: TContext,
  ): ValidationResult<FormValuesFor<TFields>> => {
    const base = validateForm<FormValuesFor<TFields>>(
      form,
      fields,
      normalizeSelectValue,
    );
    if (!base.valid) return base;
    const values = base.values;

    if (config.validate) {
      const error = config.validate(values, context as TContext);
      if (error) return { error, valid: false };
    }
    return { valid: true, values };
  };

  const render = (values: FormRenderValuesFor<TFields> = {}): string =>
    renderFields(fields, values as FieldValues);

  const section = (
    id: FormSectionId<TFields>,
    values: FormRenderValuesFor<TFields> = {},
  ): string =>
    renderFields(
      fields.filter((field) => field.section === id),
      values as FieldValues,
    );

  return {
    field: (name) => ({
      render: (value = "") => renderField(fieldByName(name), value),
    }),
    fields: config.fields,
    id: config.id,
    render,
    renderFields: render,
    section,
    sections: sectionIds,
    validate,
  };
};
