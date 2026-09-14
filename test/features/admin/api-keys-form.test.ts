import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { apiKeyForm } from "#routes/admin/api-keys-form.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { inputNamed } from "#test-utils/assertions.ts";

describe("API key form name box", () => {
  test("renders the shared single-line limit", () => {
    expect(inputNamed(apiKeyForm.render(), "name")).toContain(
      `maxlength="${MAX_INPUT_LENGTH}"`,
    );
  });

  test(`accepts a name of exactly ${MAX_INPUT_LENGTH} characters`, () => {
    const name = "x".repeat(MAX_INPUT_LENGTH);
    expect(apiKeyForm.validate(new FormParams({ name }))).toEqual({
      valid: true,
      values: { name },
    });
  });

  test(`refuses a name of ${MAX_INPUT_LENGTH + 1} characters`, () => {
    expect(
      apiKeyForm.validate(
        new FormParams({ name: "x".repeat(MAX_INPUT_LENGTH + 1) }),
      ),
    ).toEqual({
      error: `Name must be ${MAX_INPUT_LENGTH} characters or fewer`,
      valid: false,
    });
  });
});
