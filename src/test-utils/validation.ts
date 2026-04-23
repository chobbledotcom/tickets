import { expect } from "@std/expect";
import type { Field } from "#lib/forms.tsx";
import { validateForm } from "#lib/forms.tsx";
import { FormParams } from "#lib/form-data.ts";

const validateFormData = (fields: Field[], data: Record<string, string>) =>
  validateForm(new FormParams(data), fields);

export const expectValid = (
  fields: Field[],
  data: Record<string, string>,
): Record<string, unknown> => {
  const result = validateFormData(fields, data);
  expect(result.valid).toBe(true);
  return (result as { valid: true; values: Record<string, unknown> }).values;
};

export const expectInvalid =
  (expectedError: string) =>
  (fields: Field[], data: Record<string, string>): void => {
    const result = validateFormData(fields, data);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe(expectedError);
  };

export const expectInvalidForm = (
  fields: Field[],
  data: Record<string, string>,
): void => {
  expect(validateFormData(fields, data).valid).toBe(false);
};