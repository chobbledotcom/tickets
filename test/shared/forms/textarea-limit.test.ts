import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { maxTextareaValidator } from "#shared/forms/textarea-limit.ts";

describe("maxTextareaValidator", () => {
  const maximum = 3;
  const validate = maxTextareaValidator(maximum, "Reviews file");

  test("accepts text at the limit", () => {
    expect(validate("abc")).toBeNull();
  });

  test("names the field and both lengths when the text is too long", () => {
    expect(validate("abcd")).toBe(
      "Reviews file must be 3 characters or fewer (currently 4)",
    );
  });
});
