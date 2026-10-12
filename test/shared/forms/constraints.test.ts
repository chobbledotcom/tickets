import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { formFieldError } from "#shared/forms/constraints.ts";
import type { Field } from "#shared/forms/field.ts";
import { formFrom } from "#test-utils/settings-handlers.ts";

describe("formFieldError", () => {
  for (const [type, maxlength] of [
    ["text", 250],
    ["textarea", 10240],
    ["password", 250],
  ] as const) {
    test(`accepts the exact ${type} boundary`, () => {
      const field: Field = { label: "Value", maxlength, name: "value", type };
      expect(
        formFieldError(formFrom({ value: "x".repeat(maxlength) }), [field]),
      ).toBeNull();
      expect(
        formFieldError(formFrom({ value: "x".repeat(maxlength + 1) }), [field]),
      ).toBe(`Value must be ${maxlength} characters or fewer`);
    });
  }

  test("does not cap a current password", () => {
    expect(
      formFieldError(formFrom({ password: "x".repeat(1000) }), [
        { label: "Password", name: "password", type: "password" },
      ]),
    ).toBeNull();
  });

  test("leaves stored masked secrets unchanged", () => {
    expect(
      formFieldError(formFrom({ key: MASK_SENTINEL }), [
        { label: "Key", maxlength: 1, name: "key", type: "password" },
      ]),
    ).toBeNull();
  });

  test("refuses a number outside the field's declared range", () => {
    const field: Field = {
      label: "Fee",
      max: 10,
      min: 0,
      name: "fee",
      type: "number",
    };
    expect(formFieldError(formFrom({ fee: "1e3" }), [field])).toBe(
      "Fee must be 10 or fewer",
    );
    expect(formFieldError(formFrom({ fee: "-1" }), [field])).toBe(
      "Fee must be 0 or greater",
    );
    expect(formFieldError(formFrom({ fee: "0.1" }), [field])).toBeNull();
  });

  test("refuses a value the declared number type turns down", () => {
    const field: Field = { label: "Fee", name: "fee", type: "number" };
    expect(formFieldError(formFrom({ fee: "5abc" }), [field])).toBe(
      "Fee is invalid.",
    );
  });

  test("leaves a blank number field to the caller", () => {
    const field: Field = {
      label: "Fee",
      max: 10,
      min: 0,
      name: "fee",
      type: "number",
    };
    expect(formFieldError(formFrom({ fee: "" }), [field])).toBeNull();
  });
});
