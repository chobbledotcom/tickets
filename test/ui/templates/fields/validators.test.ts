import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import {
  MAX_CONTACT_LENGTH,
  validateName,
  validatePhone,
} from "#templates/fields/validators.ts";

describe("the buyer contact-length validators", () => {
  beforeAll(() => ensureMessageGroups(["validation"]));

  test("validatePhone names the limit it refuses with", () => {
    expect(validatePhone("2".repeat(MAX_CONTACT_LENGTH + 1))).toBe(
      "Phone number must be 250 characters or fewer",
    );
  });

  test("validateName names the limit it refuses with", () => {
    expect(validateName("n".repeat(MAX_CONTACT_LENGTH + 1))).toBe(
      "Name must be 250 characters or fewer",
    );
    expect(validateName("Ada Lovelace")).toBeNull();
  });
});
