/** Direct tests for forms/contact.ts — the public contact form's email field. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { getContactEmailForm } from "#shared/forms/contact.ts";
import { runWithSavedFormContext } from "#shared/forms/saved-data.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";

const invalidEmailMessage = "Please enter a valid email address.";

describe("getContactEmailForm", () => {
  test("declares one required email field with autocomplete and the cap", () => {
    const [email] = getContactEmailForm().fields;
    expect(email.autocomplete).toBe("email");
    expect(email.maxlength).toBe(MAX_INPUT_LENGTH);
    expect(email.name).toBe("email");
    expect(email.required).toBe(true);
    expect(email.type).toBe("email");
  });

  test("renders the catalogued label onto an email input", () => {
    // A fresh saved-form scope: another suite's contact POST can leave the
    // ambient store holding an "email" value, and the echo would appear here.
    expect(runWithSavedFormContext(() => getContactEmailForm().render())).toBe(
      '<label>Your email address<input autocomplete="email" maxlength="250" name="email" required type="email"></label>',
    );
  });

  test("rejects a missing email with the invalid-email message", () => {
    expect(getContactEmailForm().validate(new FormParams())).toEqual({
      error: invalidEmailMessage,
      valid: false,
    });
  });

  test("rejects a malformed email with the same message as a missing one", () => {
    for (const value of ["not-an-email", "user@example", "a@b"]) {
      expect(
        getContactEmailForm().validate(new FormParams({ email: value })),
        value,
      ).toEqual({ error: invalidEmailMessage, valid: false });
    }
  });

  test("accepts a valid email, trimmed and lowercased by parseEmail", () => {
    expect(
      getContactEmailForm().validate(
        new FormParams({ email: "  Buyer@EXAMPLE.test " }),
      ),
    ).toEqual({ valid: true, values: { email: "buyer@example.test" } });
  });

  test("rejects an email past the 250-character cap", () => {
    const localPart = "a".repeat(MAX_INPUT_LENGTH - "@example.test".length + 1);
    const result = getContactEmailForm().validate(
      new FormParams({ email: `${localPart}@example.test` }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe(
        "Your email address must be 250 characters or fewer",
      );
    }
  });
});
