import type { Field } from "#shared/forms/field.ts";

export interface FieldValues {
  [key: string]: string | number | null;
}

export const booleanToCheckbox = (value: boolean): string => (value ? "1" : "");

/** The controls that draw a stored yes/no: a checkbox group holds the tick,
 * a select holds a yes option. Both carry the same "1" a ticked box sends,
 * so one stored boolean answers for either. */
const yesNoControls: ReadonlySet<Field["type"]> = new Set([
  "checkbox-group",
  "select",
]);

/** How one form field draws an entity's stored value. A stored boolean
 * becomes the "1" its box or yes option sends; every other value is the
 * form's own text. A formatter, where one is given, still decides for its
 * field. */
const valueForField = (field: Field, raw: unknown): string | number | null =>
  typeof raw === "boolean" && yesNoControls.has(field.type)
    ? booleanToCheckbox(raw)
    : String(raw);

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
            ? valueForField(
                field,
                (entity as unknown as Record<string, unknown>)[field.name],
              )
            : "";
      return [field.name, value];
    }),
  );
  if (extra) Object.assign(values, extra);
  return values;
};
