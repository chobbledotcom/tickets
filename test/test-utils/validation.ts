import { expect } from "@std/expect";
import type { Field } from "#shared/forms/field.ts";
import { validateForm } from "#shared/forms/validation.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";

const validateFormData = (fields: readonly Field[], data: TestFormValues) =>
  validateForm(testFormParams(data), fields);

export const expectValid = (
  fields: readonly Field[],
  data: TestFormValues,
): Record<string, unknown> => {
  const result = validateFormData(fields, data);
  expect(result.valid).toBe(true);
  return (result as { valid: true; values: Record<string, unknown> }).values;
};

export const expectInvalid =
  (
    expectedError: string,
  ): ((fields: readonly Field[], data: TestFormValues) => void) =>
  (fields: readonly Field[], data: TestFormValues): void => {
    const result = validateFormData(fields, data);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe(expectedError);
  };

export const expectInvalidForm = (
  fields: readonly Field[],
  data: TestFormValues,
): void => {
  expect(validateFormData(fields, data).valid).toBe(false);
};
