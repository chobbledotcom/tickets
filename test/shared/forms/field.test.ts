/** Direct tests for forms/field.ts — the option guards that stand between an
 *  authored field list and a form that cannot render or parse. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  effectiveMaxLength,
  requireCheckboxOptions,
  requireChoiceOptions,
} from "#shared/forms/field.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";

describe("requireChoiceOptions", () => {
  test("keeps the options as authored", () => {
    const options = [{ label: "Pay", value: "pay" }];
    expect(requireChoiceOptions("Action", options)).toEqual([
      { label: "Pay", value: "pay" },
    ]);
  });

  test("refuses a select with no options at all", () => {
    expect(() => requireChoiceOptions("Action", [])).toThrow(
      "Action must define at least one option",
    );
  });
});

describe("requireCheckboxOptions", () => {
  test("keeps trimmed, non-empty, comma-free values", () => {
    const options = [{ label: "Tags", value: "vip" }];
    expect(requireCheckboxOptions("Tags", options)).toEqual([
      { label: "Tags", value: "vip" },
    ]);
  });

  test("refuses a value with a comma, so one value cannot split into two", () => {
    const options = [{ label: "Tags", value: "a,b" }];
    expect(() => requireCheckboxOptions("Tags", options)).toThrow(
      "Tags checkbox option values must be trimmed, non-empty, and contain no commas",
    );
  });

  test("refuses a later option that fails, not only the first", () => {
    const options = [
      { label: "Tags", value: "vip" },
      { label: "Tags", value: "a,b" },
    ];
    expect(() => requireCheckboxOptions("Tags", options)).toThrow(
      "Tags checkbox option values must be trimmed, non-empty, and contain no commas",
    );
  });

  test("refuses an untrimmed value, so the posted value matches the authored one", () => {
    const options = [{ label: "Tags", value: " vip" }];
    expect(() => requireCheckboxOptions("Tags", options)).toThrow(
      "Tags checkbox option values must be trimmed, non-empty, and contain no commas",
    );
  });

  test("refuses an empty value", () => {
    const options = [{ label: "Tags", value: "" }];
    expect(() => requireCheckboxOptions("Tags", options)).toThrow(
      "Tags checkbox option values must be trimmed, non-empty, and contain no commas",
    );
  });
});

describe("effectiveMaxLength", () => {
  for (const type of ["text", "email", "url", "password"] as const) {
    test(`defaults a ${type} input to the input length`, () => {
      expect(effectiveMaxLength({ label: "X", name: "x", type })).toBe(
        MAX_INPUT_LENGTH,
      );
    });
  }

  test("defaults a textarea to the textarea length", () => {
    expect(
      effectiveMaxLength({ label: "X", name: "x", type: "textarea" }),
    ).toBe(MAX_TEXTAREA_LENGTH);
  });

  test("keeps a declared limit on every kind of field", () => {
    expect(
      effectiveMaxLength({ label: "X", maxlength: 9, name: "x", type: "text" }),
    ).toBe(9);
    expect(
      effectiveMaxLength({
        label: "X",
        maxlength: 9,
        name: "x",
        type: "textarea",
      }),
    ).toBe(9);
  });

  test("keeps a declared limit of zero rather than swapping in the default", () => {
    expect(
      effectiveMaxLength({ label: "X", maxlength: 0, name: "x", type: "text" }),
    ).toBe(0);
    expect(
      effectiveMaxLength({
        label: "X",
        maxlength: 0,
        name: "x",
        type: "textarea",
      }),
    ).toBe(0);
  });

  test("leaves a parsed input without its own limit uncapped", () => {
    expect(
      effectiveMaxLength({ label: "Qty", name: "qty", type: "number" }),
    ).toBeUndefined();
  });
});
