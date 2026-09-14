import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { formLengthError } from "#shared/forms/constraints.ts";
import type { Field } from "#shared/forms/field.ts";
import { formFrom } from "#test-utils/settings-handlers.ts";

describe("formLengthError", () => {
  for (const [type, maxlength] of [
    ["text", 250],
    ["textarea", 10240],
    ["password", 250],
  ] as const) {
    test(`accepts the exact ${type} boundary`, () => {
      const field: Field = { label: "Value", maxlength, name: "value", type };
      expect(
        formLengthError(formFrom({ value: "x".repeat(maxlength) }), [field]),
      ).toBeNull();
      expect(
        formLengthError(formFrom({ value: "x".repeat(maxlength + 1) }), [
          field,
        ]),
      ).toBe(`Value must be ${maxlength} characters or fewer`);
    });
  }

  test("does not cap a current password", () => {
    expect(
      formLengthError(formFrom({ password: "x".repeat(1000) }), [
        { label: "Password", name: "password", type: "password" },
      ]),
    ).toBeNull();
  });

  test("leaves stored masked secrets unchanged", () => {
    expect(
      formLengthError(formFrom({ key: MASK_SENTINEL }), [
        { label: "Key", maxlength: 1, name: "key", type: "password" },
      ]),
    ).toBeNull();
  });
});
