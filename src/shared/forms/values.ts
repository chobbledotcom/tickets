import type { Field } from "#shared/forms/field.ts";

export interface FieldValues {
  [key: string]: string | number | null;
}

export const booleanToCheckbox = (value: boolean): string => (value ? "1" : "");

export const entityToFieldValues = <T>(
  entity: T | undefined,
  fields: readonly Field[],
  formatters: Partial<Record<keyof T, (entity: T) => string | number | null>>,
  extra?: Record<string, string | number | null>,
): FieldValues => {
  const values: FieldValues = Object.fromEntries(
    fields.map((field) => {
      const formatter = formatters[field.name as keyof T];
      const value =
        entity && formatter
          ? formatter(entity)
          : entity
            ? String((entity as unknown as Record<string, unknown>)[field.name])
            : "";
      return [field.name, value];
    }),
  );
  if (extra) Object.assign(values, extra);
  return values;
};
