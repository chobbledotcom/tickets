import type { FormParams } from "#shared/form-data.ts";
import {
  type Field,
  type FieldValueNormalizer,
  type FieldValues,
  renderField,
  renderFields,
  type ValidationResult,
  validateForm,
} from "#shared/forms.tsx";

type FormFieldDefinition = Readonly<Field>;
type FormFieldDefinitions = readonly FormFieldDefinition[];

type FormRenderValuesFor<TFields extends FormFieldDefinitions> = Partial<
  Record<TFields[number]["name"], string | number | null>
>;

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

type FormValuesFor<TFields extends FormFieldDefinitions> = {
  [F in TFields[number] as F["name"]]: NormalizedFieldValue<F>;
};

type FormFieldRenderHelper = { render: (value?: string) => string };

export type FormDefinition<
  TFields extends FormFieldDefinitions,
  TContext = undefined,
> = {
  id: string;
  fields: TFields;
  render: (values?: FormRenderValuesFor<TFields>) => string;
  renderFields: (values?: FormRenderValuesFor<TFields>) => string;
  field: (name: TFields[number]["name"]) => FormFieldRenderHelper;
  validate: (
    form: FormParams,
    context?: TContext,
  ) => ValidationResult<FormValuesFor<TFields>>;
};

const normalizeOptionalValue: FieldValueNormalizer = (
  field: Field,
  value: string | number | null,
) => {
  if (field.required) return value;
  if (field.type === "number") return value;
  return value === "" ? null : value;
};

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
  const fields = [...config.fields];
  const fieldMap = new Map(fields.map((field) => [field.name, field] as const));

  const validate = (
    form: FormParams,
    context?: TContext,
  ): ValidationResult<FormValuesFor<TFields>> => {
    const base = validateForm<FormValuesFor<TFields>>(
      form,
      fields,
      normalizeOptionalValue,
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
