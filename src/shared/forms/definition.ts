import { reduce } from "#fp";
import type { FormParams } from "#shared/form-data.ts";
import {
  type Field,
  requireCheckboxOptions,
  requireChoiceOptions,
} from "#shared/forms/field.ts";
import { renderField, renderFields } from "#shared/forms/rendering.tsx";
import {
  type ValidationResult,
  validateForm,
} from "#shared/forms/validation.ts";
import type { FieldValues } from "#shared/forms/values.ts";

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
  fields: TFields;
  render: (values?: FormRenderValuesFor<TFields>) => string;
  renderField: (name: TFields[number]["name"], value?: string) => string;
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

/** Define a typed form schema that can render and validate from one source. */
export const defineForm = <
  TFields extends FormFieldDefinitions,
  TContext = undefined,
>(config: {
  fields: TFields;
  validate?: (
    values: FormValuesFor<TFields>,
    context: TContext,
  ) => string | null;
}): FormDefinition<TFields, TContext> => {
  const fields = config.fields;
  const fieldMap = reduce((map: Map<string, Field>, field: Field) => {
    if (field.type === "select") {
      requireChoiceOptions(field.label, field.options);
    } else if (field.type === "checkbox-group") {
      requireCheckboxOptions(field.label, field.options);
    }
    map.set(field.name, field);
    return map;
  }, new Map<string, Field>())([...fields]);
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
    const base = validateForm<FormValuesFor<TFields>>(form, fields);
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
  ): string => {
    if (!sectionIds.includes(id)) throw new Error(`Unknown section: ${id}`);
    return renderFields(
      fields.filter((field) => field.section === id),
      values as FieldValues,
    );
  };

  return {
    fields: config.fields,
    render,
    renderField: (name, value = "") => renderField(fieldByName(name), value),
    section,
    sections: sectionIds,
    validate,
  };
};

/** The field shape `defineTextForm` builds: one required text box. */
type SingleTextField<TName extends string> = {
  readonly label: string;
  readonly name: TName;
  readonly placeholder: string;
  readonly required: true;
  readonly type: "text";
};

/** One required text box — the whole form for naming or renaming one thing. */
export const defineTextForm = <TName extends string>(
  label: string,
  name: TName,
  placeholder: string,
): FormDefinition<readonly [SingleTextField<TName>]> =>
  defineForm({
    fields: [
      { label, name, placeholder, required: true, type: "text" },
    ] as const,
  });
