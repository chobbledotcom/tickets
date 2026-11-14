import type { Field } from "#shared/forms/field.ts";

/** Look up a field by name, failing loudly if a factory stops emitting it. */
export const byName = (fields: readonly Field[], name: string): Field => {
  const field = fields.find((f) => f.name === name);
  if (!field) throw new Error(`no "${name}" field`);
  return field;
};

/** Whether a factory emitted a field with the given name. */
export const hasField = (fields: readonly Field[], name: string): boolean =>
  fields.some((f) => f.name === name);

/** The field spec list for these columns, in their written order. */
export const fieldSpecList = (
  kinds: Record<string, string>,
): { key: string; kind: string }[] =>
  Object.entries(kinds).map(([key, kind]) => ({ key, kind }));
