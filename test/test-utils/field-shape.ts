import type { Field } from "#shared/forms/field.ts";

/** The operator-visible shape of one field: everything the form promises.
 * Undefined keys are dropped so expected lists stay literal and compact. */
export const fieldShape = (field: Field): Record<string, unknown> => {
  const out: Record<string, unknown> = { name: field.name, type: field.type };
  for (const key of [
    "label",
    "hint",
    "placeholder",
    "required",
    "autocomplete",
    "invalidMessage",
    "section",
    "min",
    "max",
    "step",
    "visible",
    "autofocus",
  ] as const) {
    const value = (field as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  if ("options" in field && field.options) {
    out.options = field.options.map((option) => ({
      label: option.label,
      value: option.value,
    }));
  }
  return out;
};
