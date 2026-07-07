import type { Field } from "#shared/forms.tsx";

/** Look up a field by name, failing loudly if a factory stops emitting it. */
export const byName = (fields: Field[], name: string): Field => {
  const field = fields.find((f) => f.name === name);
  if (!field) throw new Error(`no "${name}" field`);
  return field;
};

/** Whether a factory emitted a field with the given name. */
export const hasField = (fields: Field[], name: string): boolean =>
  fields.some((f) => f.name === name);
