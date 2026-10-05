import type { Field } from "#shared/forms/field.ts";

/** One text field with `overrides` merged in — the shape most form-rendering
 *  and form-validation tests build their field lists from. */
export const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides }) as Field;
